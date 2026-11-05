export interface HuntLifecycleOptions {
  name: string;
  timeoutMs: number;
  /** Called once the hunt exceeds its deadline. Should close the browser/pages. */
  cancel: () => Promise<void>;
  cancelTimeoutMs?: number;
  settleTimeoutMs?: number;
}

export class HuntTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Operation ${name} timed out after ${timeoutMs}ms`);
    this.name = "HuntTimeoutError";
  }
}

export class HuntCancellationTimeoutError extends Error {
  constructor(name: string, settleTimeoutMs: number) {
    super(
      `Operation ${name} did not settle within ${settleTimeoutMs}ms after cancellation`
    );
    this.name = "HuntCancellationTimeoutError";
  }
}

/** Resolves true when the promise settles before the timeout, false otherwise. */
export function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(value);
    };

    timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(
      () => finish(true),
      () => finish(true)
    );
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * Runs a hunt with a deadline. On timeout the hunt's browser work is cancelled,
 * and the original promise is awaited for a bounded grace period so the next
 * cycle cannot overlap with the abandoned hunt.
 */
export async function runHuntWithTimeout<T>(
  operation: () => Promise<T>,
  options: HuntLifecycleOptions
): Promise<T> {
  const huntPromise = Promise.resolve().then(operation);

  // A hunt that rejects after the timeout must not become an unhandled
  // rejection; the timeout path below inspects its settlement separately.
  huntPromise.catch(() => {});

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      huntPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new HuntTimeoutError(options.name, options.timeoutMs));
        }, options.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (!timedOut) {
      throw error;
    }

    try {
      await withTimeout(
        Promise.resolve().then(options.cancel),
        options.cancelTimeoutMs ?? 15_000,
        `Cancellation for ${options.name} timed out`
      );
    } catch (cancelError) {
      console.error(`Cancellation for ${options.name} failed:`, cancelError);
    }

    const settleTimeoutMs = options.settleTimeoutMs ?? 30_000;
    const settled = await waitForSettlement(huntPromise, settleTimeoutMs);
    if (!settled) {
      throw new HuntCancellationTimeoutError(options.name, settleTimeoutMs);
    }

    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
