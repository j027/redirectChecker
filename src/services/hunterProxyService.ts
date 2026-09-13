import { fetch, ProxyAgent } from "undici";
import { setTimeout as sleep } from "timers/promises";
import { readConfig } from "../config.js";
import { logProxyEvent } from "./proxyEventLogger.js";

type ProxyState = "ready" | "rotating";

interface RotationResponse {
  ok?: boolean;
  oldIp?: string | null;
  newIp?: string | null;
  detail?: string;
}

export interface HunterProxyRunContext {
  isHealthy: () => boolean;
}

export class HunterProxyService {
  private state: ProxyState = "ready";
  private healthy = true;
  private inFlight = 0;
  private waiters = new Set<() => void>();
  private lastKnownIp: string | null = null;
  private lastRecoveryAttempt = 0;
  private recoveryProbe: Promise<boolean> | null = null;
  private generation = 0;

  drainTimeoutMs = 120_000;
  rotationRequestTimeoutMs = 300_000;
  recoveryTimeoutMs = 120_000;
  recoveryProbeIntervalMs = 5_000;
  recoveryProbeTimeoutMs = 15_000;
  recoveryAttemptIntervalMs = 15_000;

  isHealthy(): boolean {
    return this.state === "ready" && this.healthy;
  }

  getLastKnownIp(): string | null {
    return this.lastKnownIp;
  }

  async run<T>(
    operationName: string,
    fn: (ctx: HunterProxyRunContext) => Promise<T>
  ): Promise<T> {
    await this.acquire(operationName);
    const generation = this.generation;
    const ctx: HunterProxyRunContext = {
      isHealthy: () => this.isHealthy() && this.generation === generation,
    };

    try {
      return await fn(ctx);
    } finally {
      this.release();
    }
  }

  private async acquire(operationName: string): Promise<void> {
    if (!this.healthy && this.state === "ready") {
      await this.tryRecoverProxy(`before ${operationName}`);
    }

    while (this.state !== "ready") {
      await this.wait();
    }

    this.inFlight++;
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) {
      this.wakeWaiters();
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private wakeWaiters(): void {
    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const resolve of waiters) {
      resolve();
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
          await logProxyEvent("rotation_recovered", `Hunter proxy reachable again at ${ip} (${reason})`, {
            ipAddress: ip,
          });
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
      await logProxyEvent("error", "Failed to reach hunter proxy during IP check");
      return;
    }

    this.healthy = true;
    console.log(`Hunter proxy IP: ${ip}`);
    await logProxyEvent("ip_check", `Hunter proxy IP: ${ip}`, { ipAddress: ip });
  }

  async rotate(reason: string): Promise<boolean> {
    const config = await readConfig();
    if (!config.hunterProxyRotationUrl) {
      return this.healthy;
    }

    if (this.state === "rotating") {
      while (this.state === "rotating") {
        await this.wait();
      }
      return this.healthy;
    }

    this.state = "rotating";
    console.log(`Starting hunter proxy rotation: ${reason}`);
    await logProxyEvent("rotation_start", `Starting hunter proxy rotation: ${reason}`);

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

    while (this.inFlight > 0) {
      if (Date.now() - start >= this.drainTimeoutMs) {
        console.error(
          `Rotation proceeding with ${this.inFlight} in-flight hunter proxy operation(s) after drain timeout`
        );
        await logProxyEvent(
          "drain_timeout",
          `Rotation proceeding with ${this.inFlight} in-flight operation(s) after ${this.drainTimeoutMs}ms`
        );
        return;
      }
      await this.wait();
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
        await logProxyEvent("rotation", "Rotation skipped (cooldown active)", { statusCode: 429 });
        return true;
      }

      if (response.ok && body.ok !== false) {
        const oldIp = body.oldIp ?? "?";
        const newIp = body.newIp ?? "?";
        if (body.newIp) {
          this.lastKnownIp = body.newIp;
        }
        console.log(`Hunter proxy rotated: ${oldIp} -> ${newIp}`);
        await logProxyEvent("rotation_complete", `Rotation complete: ${oldIp} -> ${newIp}`, {
          ipAddress: body.newIp ?? undefined,
          statusCode: response.status,
        });
        return true;
      }

      await logProxyEvent(
        "rotation_failed",
        `Rotation failed: ${body.detail ?? `${response.status} ${response.statusText}`}`,
        { statusCode: response.status }
      );
      return false;
    } catch (error) {
      console.error(`Hunter proxy rotation request failed: ${error}`);
      await logProxyEvent(
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
        await logProxyEvent("rotation_recovered", `Hunter proxy reachable after rotation attempt at ${ip}`, {
          ipAddress: ip,
        });
        return true;
      }
    }

    console.error("Hunter proxy did not recover after rotation attempt");
    await logProxyEvent(
      "rotation_failed",
      `Hunter proxy unreachable ${this.recoveryTimeoutMs}ms after rotation attempt`
    );
    return false;
  }
}

export const hunterProxyService = new HunterProxyService();
