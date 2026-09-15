import { BrowserContext, Page } from "patchright";
import type { CDPSession } from "patchright";

/** Worker targets needed while armed before the page is treated as a bomb. */
export const BOMB_WORKER_THRESHOLD = 3;

const WORKER_TARGET_TYPES = new Set(["worker", "shared_worker"]);
const DEFAULT_QUIET_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 6000;
const ARM_SETTLE_MS = 200;

/**
 * Disarms fork bombs during the "leaving the page" phase.
 *
 * Arming attaches to the page's CDP target with waitForDebuggerOnStart, so every
 * child target created afterwards (workers, popups, frames) starts frozen before
 * its first instruction runs. Worker targets are tracked through two channels:
 * attachedToTarget (pauses them) and targetCreated discovery (catches any target
 * the attach race missed). If the page creates BOMB_WORKER_THRESHOLD or more
 * while armed it is treated as a bomb and the over-threshold targets are closed.
 *
 * Nothing is ever resumed during this phase: bomb payloads never execute, so
 * worker -> worker replication cannot start, and legitimate unload workers are
 * inert for the few seconds until the context is torn down (the classification
 * screenshot and verdict are already captured before arming).
 */
export class BombGuard {
  private session: CDPSession | null = null;
  private mainTargetId: string | null = null;
  private armed = false;
  private disposed = false;
  private bombDetected = false;
  private workerTargetIds: string[] = [];
  private seenTargetIds = new Set<string>();
  private lastWorkerAt = 0;
  private armedAt = 0;

  async arm(context: BrowserContext, page: Page): Promise<void> {
    if (this.armed || this.disposed) {
      return;
    }
    this.armed = true;
    this.armedAt = Date.now();
    this.lastWorkerAt = Date.now();

    try {
      const session = await context.newCDPSession(page);
      this.session = session;

      const targetInfo = await session.send("Target.getTargetInfo");
      this.mainTargetId = targetInfo.targetInfo.targetId;
      this.seenTargetIds.add(this.mainTargetId);

      // Ignore pre-existing targets, otherwise discovery would report workers
      // from before the guard was armed (e.g. a previous cycle's leftovers).
      const existing = await session.send("Target.getTargets");
      for (const target of existing.targetInfos) {
        this.seenTargetIds.add(target.targetId);
      }

      session.on("Target.attachedToTarget", (event) => {
        void this.handleAttached(event);
      });
      session.on("Target.targetCreated", (event) => {
        void this.handleTargetCreated(event);
      });

      await session.send("Target.setDiscoverTargets", { discover: true });
      await session.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      // Dispatching immediately can race the browser applying auto-attach, which
      // lets early worker targets run un-paused. Give the commands a moment.
      await new Promise((resolve) => setTimeout(resolve, ARM_SETTLE_MS));
    } catch (error) {
      console.error("[BombGuard] Failed to arm bomb guard:", error);
    }
  }

  private async handleAttached(event: {
    sessionId: string;
    targetInfo: { targetId: string; type: string; url: string };
  }): Promise<void> {
    const type = event.targetInfo?.type;
    const targetId = event.targetInfo?.targetId;
    if (targetId == null) {
      return;
    }

    // Popups created while armed are closed instead of frozen, so a popup bomb
    // cannot keep opening windows while the context is being torn down.
    if (type === "page" && targetId !== this.mainTargetId) {
      this.seenTargetIds.add(targetId);
      await this.closeTarget(targetId);
      return;
    }

    if (!WORKER_TARGET_TYPES.has(type)) {
      return;
    }

    await this.registerWorkerTarget(targetId);
  }

  private async handleTargetCreated(event: {
    targetInfo: { targetId: string; type: string; url: string };
  }): Promise<void> {
    const type = event.targetInfo?.type;
    const targetId = event.targetInfo?.targetId;
    if (targetId == null || this.seenTargetIds.has(targetId)) {
      return;
    }

    if (type === "page" && targetId !== this.mainTargetId) {
      this.seenTargetIds.add(targetId);
      await this.closeTarget(targetId);
      return;
    }

    if (!WORKER_TARGET_TYPES.has(type)) {
      return;
    }

    await this.registerWorkerTarget(targetId);
  }

  private async registerWorkerTarget(targetId: string): Promise<void> {
    if (this.seenTargetIds.has(targetId)) {
      return;
    }
    this.seenTargetIds.add(targetId);
    this.workerTargetIds.push(targetId);
    this.lastWorkerAt = Date.now();

    if (this.workerTargetIds.length >= BOMB_WORKER_THRESHOLD) {
      if (!this.bombDetected) {
        this.bombDetected = true;
        console.warn(
          `[BombGuard] Worker bomb detected: ${this.workerTargetIds.length} worker targets created while leaving the page`
        );
      }
      await this.closeTarget(targetId);
    }
  }

  private async closeTarget(targetId: string): Promise<void> {
    if (this.session == null) {
      return;
    }
    try {
      await this.session.send("Target.closeTarget", { targetId });
    } catch {
      // Target may already be gone
    }
  }

  /**
   * Dispatches the unload event over the guard's own CDP session.
   *
   * Sending this on the same session as setAutoAttach guarantees the browser
   * processes auto-attach before the page's handlers run; going through a
   * different session (e.g. Playwright's evaluate) can race under load and let
   * early worker targets start un-paused.
   */
  async dispatchUnloadEvent(): Promise<void> {
    if (this.session == null) {
      return;
    }
    try {
      await this.session.send("Runtime.evaluate", {
        expression: "window.dispatchEvent(new Event('beforeunload'));",
        awaitPromise: false,
        returnByValue: true,
      });
    } catch (error) {
      console.warn("[BombGuard] Failed to dispatch unload event:", error);
    }
  }

  /**
   * Lowers the page's worker construction cap through the injected hook. A cap
   * of 0 turns every Worker construction into an inert stub, so a leave-bomb
   * cannot execute or leave frozen targets behind at teardown.
   */
  async setWorkerCap(maxRealWorkers: number): Promise<void> {
    if (this.session == null) {
      return;
    }
    try {
      await this.session.send("Runtime.evaluate", {
        expression: `window.__sbMaxRealWorkers = ${maxRealWorkers};`,
        awaitPromise: false,
        returnByValue: true,
      });
    } catch (error) {
      console.warn("[BombGuard] Failed to set worker cap:", error);
    }
  }

  /**
   * Applies CPU throttling to the guarded page so a main-thread busy loop
   * cannot monopolise the machine while child targets are frozen.
   */
  async throttle(rate: number): Promise<void> {
    if (this.session == null) {
      return;
    }
    try {
      await this.session.send("Emulation.setCPUThrottlingRate", { rate });
    } catch (error) {
      console.warn("[BombGuard] Failed to set CPU throttling:", error);
    }
  }

  /**
   * Waits until worker target creation goes quiet, or until the hard cap
   * elapses. Resolves immediately once a bomb is confirmed.
   */
  async waitForSettle(
    quietMs: number = DEFAULT_QUIET_MS,
    maxWaitMs: number = DEFAULT_MAX_WAIT_MS
  ): Promise<boolean> {
    const start = Date.now();
    const minWaitMs = Math.min(quietMs, 500);

    while (Date.now() - start < maxWaitMs) {
      if (this.bombDetected) {
        return true;
      }

      const now = Date.now();
      if (now - this.armedAt >= minWaitMs && now - this.lastWorkerAt >= quietMs) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.bombDetected;
  }

  isBombDetected(): boolean {
    return this.bombDetected;
  }

  getWorkerTargetCount(): number {
    return this.workerTargetIds.length;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const session = this.session;
    this.session = null;

    if (session == null) {
      return;
    }

    // Detaching releases waitForDebuggerOnStart, which would let every frozen
    // target run its payload, so the targets are closed first. Neither CDP call
    // is allowed to be unbounded: a stalled send must not hold the operation
    // open (the caller also retires the browser once teardown is done).
    const targetIds = [...this.workerTargetIds];
    const targetsClosed = await this.raceWithTimeout(
      Promise.allSettled(
        targetIds.map((targetId) =>
          session
            .send("Target.closeTarget", { targetId })
            .catch(() => undefined)
        )
      ),
      3000
    );

    if (!targetsClosed) {
      console.warn(
        "[BombGuard] Timed out closing frozen worker targets; detaching anyway"
      );
    }

    await this.raceWithTimeout(
      session.detach().catch(() => undefined),
      2000
    );
  }

  private async raceWithTimeout(
    promise: Promise<unknown>,
    ms: number
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(() => true).catch(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
