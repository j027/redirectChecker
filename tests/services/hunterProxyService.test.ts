import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setTimeout as sleep } from "timers/promises";

vi.mock("../../src/services/proxyEventLogger.js", () => ({
  logProxyEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  readConfig: vi.fn().mockResolvedValue({
    hunterProxy: "http://user:pass@mobileproxy:3128/",
    hunterProxyRotationUrl: "http://mobileproxy:8080/r/token",
  }),
}));

import { HunterProxyService } from "../../src/services/hunterProxyService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("HunterProxyService", () => {
  let service: HunterProxyService;

  beforeEach(() => {
    service = new HunterProxyService();
    service.drainTimeoutMs = 500;
    service.recoveryProbeIntervalMs = 5;
    service.recoveryTimeoutMs = 100;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs operations immediately when ready", async () => {
    const result = await service.run("op", async () => 42);

    expect(result).toBe(42);
    expect(service.isHealthy()).toBe(true);
  });

  it("waits for in-flight operations to drain before rotating", async () => {
    const gate = deferred<void>();
    const events: string[] = [];

    const running = service.run("op", async () => {
      events.push("op-start");
      await gate.promise;
      events.push("op-end");
      return "done";
    });

    const trigger = vi
      .spyOn(service as any, "triggerRotation")
      .mockImplementation(async () => {
        events.push("rotate");
        return true;
      });

    const rotating = service.rotate("test");

    await sleep(30);
    expect(trigger).not.toHaveBeenCalled();

    gate.resolve();
    await running;
    await rotating;

    expect(events).toEqual(["op-start", "op-end", "rotate"]);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("blocks new operations while rotation is in progress", async () => {
    const rotationGate = deferred<boolean>();
    vi.spyOn(service as any, "triggerRotation").mockImplementation(
      () => rotationGate.promise
    );

    const rotating = service.rotate("test");
    await sleep(10);

    let ran = false;
    const runPromise = service.run("op", async () => {
      ran = true;
      return "ok";
    });

    await sleep(20);
    expect(ran).toBe(false);

    rotationGate.resolve(true);
    await rotating;
    await expect(runPromise).resolves.toBe("ok");
    expect(ran).toBe(true);
  });

  it("wakes waiting operations after a failed rotation and marks the proxy unhealthy", async () => {
    vi.spyOn(service as any, "triggerRotation").mockResolvedValue(false);
    vi.spyOn(service as any, "probeIp").mockResolvedValue(null);
    service.recoveryTimeoutMs = 20;
    service.recoveryProbeIntervalMs = 5;

    const rotating = service.rotate("test");
    await sleep(10);

    let ran = false;
    const runPromise = service.run("op", async () => {
      ran = true;
      return "ok";
    });

    await expect(rotating).resolves.toBe(false);
    await expect(runPromise).resolves.toBe("ok");
    expect(ran).toBe(true);
    expect(service.isHealthy()).toBe(false);
  });

  it("recovers proxy health during the post-rotation probe", async () => {
    vi.spyOn(service as any, "triggerRotation").mockResolvedValue(false);
    vi.spyOn(service as any, "probeIp").mockResolvedValue("1.2.3.4");

    await expect(service.rotate("test")).resolves.toBe(true);
    expect(service.isHealthy()).toBe(true);
  });

  it("marks operations that span a rotation as unhealthy", async () => {
    const gate = deferred<void>();
    vi.spyOn(service as any, "triggerRotation").mockResolvedValue(true);
    vi.spyOn(service as any, "probeIp").mockResolvedValue(null);
    service.drainTimeoutMs = 10;

    let healthyDuringOp: boolean | null = null;
    const running = service.run("spanning-op", async (ctx) => {
      await gate.promise;
      healthyDuringOp = ctx.isHealthy();
      return "done";
    });

    await sleep(10);
    const rotating = service.rotate("test");
    await sleep(40);
    gate.resolve();

    await running;
    await rotating;

    expect(healthyDuringOp).toBe(false);
  });

  it("returns true when rotation is unavailable in config", async () => {
    const config = await import("../../src/config.js");
    vi.mocked(config.readConfig).mockResolvedValueOnce({
      hunterProxy: "http://user:pass@mobileproxy:3128/",
    } as any);

    const trigger = vi.spyOn(service as any, "triggerRotation");

    await expect(service.rotate("test")).resolves.toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("proceeds after the drain timeout when an operation never releases", async () => {
    service.drainTimeoutMs = 30;
    const trigger = vi
      .spyOn(service as any, "triggerRotation")
      .mockResolvedValue(true);

    const never = deferred<void>();
    const running = service.run("hung-op", async (ctx) => {
      await never.promise;
      return ctx.isHealthy();
    });

    await sleep(5);
    const rotating = service.rotate("test");

    await expect(rotating).resolves.toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);

    never.resolve();
    await expect(running).resolves.toBe(false);
  });

  it("allows nested operations to finish while rotation is in progress", async () => {
    const rotationGate = deferred<void>();
    const events: string[] = [];

    vi.spyOn(service as any, "triggerRotation").mockImplementation(async () => {
      events.push("rotate-start");
      await rotationGate.promise;
      events.push("rotate-end");
      return true;
    });

    const outer = service.run("outer", async () => {
      events.push("outer-start");
      await sleep(15);
      const inner = await service.run("inner", async () => {
        events.push("inner");
        return "inner-result";
      });
      events.push("outer-end");
      return inner;
    });

    await sleep(1);
    const rotating = service.rotate("test");

    await expect(outer).resolves.toBe("inner-result");
    expect(events.slice(0, 3)).toEqual(["outer-start", "inner", "outer-end"]);
    expect(events).toContain("rotate-start");
    expect(events).not.toContain("rotate-end");

    rotationGate.resolve();
    await rotating;
    expect(events[events.length - 1]).toBe("rotate-end");
  });

  it("force-releases operations that exceed the watchdog timeout", async () => {
    service.operationTimeoutMs = 30;
    vi.spyOn(service as any, "probeIp").mockResolvedValue(null);
    vi.spyOn(service as any, "triggerRotation").mockResolvedValue(true);

    const never = deferred<void>();
    const hung = service.run("hung-op", async () => {
      await never.promise;
      return "late";
    });

    await expect(hung).rejects.toThrow(/timed out after 30ms/);
    expect(service.isHealthy()).toBe(false);

    const recovered = service.run("after-timeout", async () => "ok");
    await expect(recovered).resolves.toBe("ok");

    never.resolve();
  });
});
