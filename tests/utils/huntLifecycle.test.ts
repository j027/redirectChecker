import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HuntCancellationTimeoutError,
  HuntTimeoutError,
  waitForSettlement,
  runHuntWithTimeout,
} from "../../src/utils/huntLifecycle.js";

describe("runHuntWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result when the hunt finishes in time", async () => {
    const cancel = vi.fn(async () => {});
    await expect(
      runHuntWithTimeout(async () => "ok", {
        name: "test hunt",
        timeoutMs: 1_000,
        cancel,
      })
    ).resolves.toBe("ok");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("propagates hunt errors without cancelling", async () => {
    const cancel = vi.fn(async () => {});
    await expect(
      runHuntWithTimeout(
        async () => {
          throw new Error("hunt failed");
        },
        { name: "test hunt", timeoutMs: 1_000, cancel }
      )
    ).rejects.toThrow("hunt failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a timed-out hunt and waits for it to settle", async () => {
    vi.useFakeTimers();

    let resolveHunt!: () => void;
    const huntPromise = new Promise<void>((resolve) => {
      resolveHunt = resolve;
    });
    const cancel = vi.fn(async () => {
      resolveHunt();
    });

    const result = runHuntWithTimeout(() => huntPromise, {
      name: "slow hunt",
      timeoutMs: 1_000,
      cancel,
      settleTimeoutMs: 5_000,
    });

    const assertion = expect(result).rejects.toBeInstanceOf(HuntTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a cancellation that never settles", async () => {
    vi.useFakeTimers();

    const huntPromise = new Promise<void>(() => {});
    const cancel = vi.fn(async () => {});

    const result = runHuntWithTimeout(() => huntPromise, {
      name: "stuck hunt",
      timeoutMs: 1_000,
      cancel,
      settleTimeoutMs: 100,
    });

    const assertion = expect(result).rejects.toBeInstanceOf(
      HuntCancellationTimeoutError
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("waitForSettlement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for both resolved and rejected promises", async () => {
    await expect(waitForSettlement(Promise.resolve(), 100)).resolves.toBe(true);
    await expect(
      waitForSettlement(Promise.reject(new Error("boom")), 100)
    ).resolves.toBe(true);
  });

  it("returns false when the timeout wins", async () => {
    vi.useFakeTimers();
    const result = waitForSettlement(new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(false);
  });
});
