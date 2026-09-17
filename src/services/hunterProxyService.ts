import { AsyncLocalStorage } from "async_hooks";
import { fetch, ProxyAgent } from "undici";
import { setTimeout as sleep } from "timers/promises";
import { readConfig } from "../config.js";
import { logProxyEvent, ProxyEventType } from "./proxyEventLogger.js";

export type ProxyState = "ready" | "rotating";
type Waiter = (woken: boolean) => void;
type ProxyEventOptions = { ipAddress?: string; statusCode?: number };

interface ActiveOperation {
  name: string;
  startedAt: number;
}

export interface HunterProxyStatus {
  state: ProxyState;
  healthy: boolean;
  inFlight: number;
  operations: { name: string; elapsedMs: number }[];
  waiters: number;
  lastKnownIp: string | null;
  generation: number;
}

interface RotationResponse {
  ok?: boolean;
  oldIp?: string | null;
  newIp?: string | null;
  detail?: string;
}

export interface HunterProxyRunContext {
  isHealthy: () => boolean;
}

export interface HunterProxyRunOptions {
  signal?: AbortSignal;
}

function createAbortError(operationName: string): Error {
  const error = new Error(`Operation "${operationName}" was cancelled`);
  error.name = "AbortError";
  return error;
}

export class HunterProxyService {
  private state: ProxyState = "ready";
  private healthy = true;
  private inFlight = 0;
  private waiters = new Set<Waiter>();
  private lastKnownIp: string | null = null;
  private lastRecoveryAttempt = 0;
  private recoveryProbe: Promise<boolean> | null = null;
  private generation = 0;
  private operationContext = new AsyncLocalStorage<HunterProxyRunContext>();
  private activeOperations = new Map<number, ActiveOperation>();
  private nextOperationId = 1;

  drainTimeoutMs = 120_000;
  rotationRequestTimeoutMs = 300_000;
  recoveryTimeoutMs = 120_000;
  recoveryProbeIntervalMs = 5_000;
  recoveryProbeTimeoutMs = 15_000;
  recoveryAttemptIntervalMs = 15_000;
  /** Upper bound on how long a new operation waits for an in-progress rotation. */
  acquireTimeoutMs = 600_000;
  /** Upper bound on how long a concurrent rotate() call waits for the active one. */
  rotationMaxWaitMs = 900_000;
  /** Watchdog per gated operation. On expiry the slot is force-released. */
  operationTimeoutMs = 300_000;
  /** Upper bound on how long proxy event logging may hold up rotation. */
  eventLogTimeoutMs = 5_000;

  isHealthy(): boolean {
    return this.state === "ready" && this.healthy;
  }

  getStatus(): HunterProxyStatus {
    return {
      state: this.state,
      healthy: this.healthy,
      inFlight: this.inFlight,
      operations: Array.from(this.activeOperations.values()).map((op) => ({
        name: op.name,
        elapsedMs: Date.now() - op.startedAt,
      })),
      waiters: this.waiters.size,
      lastKnownIp: this.lastKnownIp,
      generation: this.generation,
    };
  }

  private describeInFlight(): string {
    const counts = new Map<string, number>();
    for (const op of this.activeOperations.values()) {
      counts.set(op.name, (counts.get(op.name) ?? 0) + 1);
    }
    const parts = Array.from(counts.entries()).map(([name, count]) =>
      count > 1 ? `${name} x${count}` : name
    );
    return parts.length > 0 ? parts.join(", ") : "none";
  }

  private reportAbandonedSettlement(
    operationName: string,
    startedAt: number,
    wasAbandoned: boolean,
    outcome: string
  ): void {
    if (!wasAbandoned) {
      return;
    }
    console.warn(
      `Abandoned hunter proxy operation "${operationName}" settled after ${Date.now() - startedAt}ms (${outcome}); result discarded`
    );
  }

  getLastKnownIp(): string | null {
    return this.lastKnownIp;
  }

  async run<T>(
    operationName: string,
    fn: (ctx: HunterProxyRunContext) => Promise<T>,
    options: HunterProxyRunOptions = {}
  ): Promise<T> {
    // Nested calls are part of an operation that is already counted as in-flight.
    // Blocking them behind a rotation would deadlock: drain waits for the outer
    // operation, which in turn waits for the nested one, which waits for the
    // rotation to finish. They must therefore proceed immediately.
    const inheritedContext = this.operationContext.getStore();
    if (inheritedContext) {
      if (options.signal?.aborted) {
        throw createAbortError(operationName);
      }
      return fn(inheritedContext);
    }

    const { signal } = options;
    if (signal?.aborted) {
      throw createAbortError(operationName);
    }

    await this.acquire(operationName, signal);

    const startedAt = Date.now();
    const operationId = this.nextOperationId++;
    this.activeOperations.set(operationId, { name: operationName, startedAt });
    let wasAbandoned = false;

    const generation = this.generation;
    // Health is generation-based, not state-based: while a rotation is draining
    // in-flight operations the proxy has not been swapped yet, so those
    // operations must still be treated as valid. Once the rotation bumps the
    // generation (or a failure flips `healthy`), stale operations are voided.
    const ctx: HunterProxyRunContext = {
      isHealthy: () => this.healthy && this.generation === generation,
    };

    let released = false;
    let abandonReject: ((error: Error) => void) | null = null;
    const abandoned = new Promise<never>((_, reject) => {
      abandonReject = reject;
    });

    const release = (reason?: string) => {
      if (released) {
        return;
      }
      released = true;
      this.activeOperations.delete(operationId);
      this.inFlight = Math.max(0, this.inFlight - 1);

      if (reason != null) {
        wasAbandoned = true;
        this.healthy = false;
        this.generation++;
        console.error(
          `Force-releasing hunter proxy operation "${operationName}": ${reason}`
        );
        void this.logEventSafe(
          "operation_timeout",
          `Force-released "${operationName}": ${reason}`
        );
      }

      if (this.inFlight === 0) {
        this.wakeWaiters();
      }
    };

    const forceRelease = (reason: string, error: Error) => {
      release(reason);
      abandonReject?.(error);
    };

    const onAbort = () =>
      forceRelease("cancelled by caller", createAbortError(operationName));

    const watchdog = setTimeout(
      () =>
        forceRelease(
          `exceeded ${this.operationTimeoutMs}ms`,
          new Error(
            `Operation "${operationName}" timed out after ${this.operationTimeoutMs}ms`
          )
        ),
      this.operationTimeoutMs
    );
    watchdog.unref();

    signal?.addEventListener("abort", onAbort, { once: true });

    const operationPromise = this.operationContext.run(ctx, () => fn(ctx));
    void operationPromise.then(
      () => this.reportAbandonedSettlement(operationName, startedAt, wasAbandoned, "completed"),
      (error) =>
        this.reportAbandonedSettlement(
          operationName,
          startedAt,
          wasAbandoned,
          `failed: ${error instanceof Error ? error.message : String(error)}`
        )
    );

    try {
      return await Promise.race([operationPromise, abandoned]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(watchdog);
      release();
    }
  }

  private async acquire(operationName: string, signal?: AbortSignal): Promise<void> {
    if (!this.healthy && this.state === "ready") {
      await this.tryRecoverProxy(`before ${operationName}`);
    }

    const start = Date.now();
    while (this.state !== "ready") {
      if (signal?.aborted) {
        throw createAbortError(operationName);
      }

      const remaining = this.acquireTimeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        console.error(
          `Operation "${operationName}" waited ${this.acquireTimeoutMs}ms for hunter proxy rotation; proceeding with the current proxy`
        );
        await this.logEventSafe(
          "acquire_timeout",
          `"${operationName}" proceeded after waiting ${this.acquireTimeoutMs}ms for rotation`
        );
        break;
      }

      await this.wait(remaining);
    }

    this.inFlight++;
  }

  private wait(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;

      const finish = (woken: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(woken);
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.waiters.add(finish);
    });
  }

  private wakeWaiters(): void {
    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter(true);
    }
  }

  private async tryRecoverProxy(reason: string): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastRecoveryAttempt < this.recoveryAttemptIntervalMs) {
      return this.healthy;
    }
    this.lastRecoveryAttempt = now;

    if (!this.recoveryProbe) {
      this.recoveryProbe = (async () => {
        const ip = await this.probeIp();
        if (ip && !this.healthy) {
          this.healthy = true;
          console.log(`Hunter proxy reachable again at ${ip} (${reason})`);
          await this.logEventSafe(
            "rotation_recovered",
            `Hunter proxy reachable again at ${ip} (${reason})`,
            { ipAddress: ip }
          );
        }
        return ip != null;
      })().finally(() => {
        this.recoveryProbe = null;
      });
    }

    return this.recoveryProbe;
  }

  async probeIp(): Promise<string | null> {
    try {
      const config = await readConfig();
      const response = await fetch("https://api.ipify.org?format=json", {
        dispatcher: new ProxyAgent(config.hunterProxy),
        signal: AbortSignal.timeout(this.recoveryProbeTimeoutMs),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { ip?: string };
      if (!data.ip) {
        return null;
      }

      this.lastKnownIp = data.ip;
      return data.ip;
    } catch {
      return null;
    }
  }

  async refreshIpAndLog(): Promise<void> {
    const ip = await this.probeIp();

    if (!ip) {
      console.error("Failed to log hunter proxy IP");
      await this.logEventSafe("error", "Failed to reach hunter proxy during IP check");
      return;
    }

    if (this.state === "ready") {
      this.healthy = true;
    }
    console.log(`Hunter proxy IP: ${ip}`);
    await this.logEventSafe("ip_check", `Hunter proxy IP: ${ip}`, { ipAddress: ip });
  }

  async rotate(reason: string): Promise<boolean> {
    const config = await readConfig();
    if (!config.hunterProxyRotationUrl) {
      return this.healthy;
    }

    if (this.state === "rotating") {
      const start = Date.now();
      while (this.state === "rotating") {
        const remaining = this.rotationMaxWaitMs - (Date.now() - start);
        if (remaining <= 0) {
          console.error(
            `Rotation wait exceeded ${this.rotationMaxWaitMs}ms; returning current proxy health`
          );
          break;
        }
        await this.wait(remaining);
      }
      return this.healthy;
    }

    this.state = "rotating";
    console.log(`Starting hunter proxy rotation: ${reason}`);
    await this.logEventSafe("rotation_start", `Starting hunter proxy rotation: ${reason}`);

    let success = false;
    try {
      await this.waitForDrain();
      this.generation++;
      success = await this.triggerRotation(config.hunterProxyRotationUrl);
      if (!success) {
        success = await this.waitForProxyRecovery();
      }
    } finally {
      this.healthy = success;
      this.state = "ready";
      this.wakeWaiters();
    }

    return success;
  }

  private async waitForDrain(): Promise<void> {
    const start = Date.now();
    const initialInFlight = this.inFlight;

    if (initialInFlight > 0) {
      console.log(
        `Rotation waiting for ${initialInFlight} in-flight operation(s) to drain: ${this.describeInFlight()}`
      );
    }

    while (this.inFlight > 0) {
      const remaining = this.drainTimeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        console.error(
          `Rotation proceeding with ${this.inFlight} in-flight hunter proxy operation(s) after drain timeout`
        );
        await this.logEventSafe(
          "drain_timeout",
          `Rotation proceeding with ${this.inFlight} in-flight operation(s) after ${this.drainTimeoutMs}ms`
        );
        return;
      }
      await this.wait(remaining);
    }

    if (initialInFlight > 0) {
      console.log(`Rotation drain complete after ${Date.now() - start}ms`);
    }
  }

  private async triggerRotation(rotationUrl: string): Promise<boolean> {
    try {
      const response = await fetch(rotationUrl, {
        signal: AbortSignal.timeout(this.rotationRequestTimeoutMs),
      });

      let body: RotationResponse = {};
      try {
        body = (await response.json()) as RotationResponse;
      } catch {}

      if (response.status === 429) {
        console.log("Hunter proxy rotation skipped: cooldown active");
        await this.logEventSafe("rotation", "Rotation skipped (cooldown active)", { statusCode: 429 });
        return true;
      }

      if (response.ok && body.ok !== false) {
        const oldIp = body.oldIp ?? "?";
        const newIp = body.newIp ?? "?";
        if (body.newIp) {
          this.lastKnownIp = body.newIp;
        }
        console.log(`Hunter proxy rotated: ${oldIp} -> ${newIp}`);
        await this.logEventSafe("rotation_complete", `Rotation complete: ${oldIp} -> ${newIp}`, {
          ipAddress: body.newIp ?? undefined,
          statusCode: response.status,
        });
        return true;
      }

      await this.logEventSafe(
        "rotation_failed",
        `Rotation failed: ${body.detail ?? `${response.status} ${response.statusText}`}`,
        { statusCode: response.status }
      );
      return false;
    } catch (error) {
      console.error(`Hunter proxy rotation request failed: ${error}`);
      await this.logEventSafe(
        "rotation_failed",
        `Rotation request failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  private async waitForProxyRecovery(): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < this.recoveryTimeoutMs) {
      await sleep(this.recoveryProbeIntervalMs);
      const ip = await this.probeIp();
      if (ip) {
        console.log(`Hunter proxy recovered at ${ip}`);
        await this.logEventSafe("rotation_recovered", `Hunter proxy reachable after rotation attempt at ${ip}`, {
          ipAddress: ip,
        });
        return true;
      }
    }

    console.error("Hunter proxy did not recover after rotation attempt");
    await this.logEventSafe(
      "rotation_failed",
      `Hunter proxy unreachable ${this.recoveryTimeoutMs}ms after rotation attempt`
    );
    return false;
  }

  /**
   * Bounded proxy event logging: a slow or wedged database must never hold the
   * rotation lock (or any caller) hostage.
   */
  private async logEventSafe(
    eventType: ProxyEventType,
    message: string,
    opts?: ProxyEventOptions
  ): Promise<void> {
    try {
      await Promise.race([
        logProxyEvent(eventType, message, opts),
        sleep(this.eventLogTimeoutMs),
      ]);
    } catch (error) {
      console.error(`Failed to log proxy event (${eventType}): ${error}`);
    }
  }
}

export const hunterProxyService = new HunterProxyService();
