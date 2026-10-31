import { BrowserContext } from "patchright";

export type StorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => {
    if (timer != null) {
      clearTimeout(timer);
    }
  });
}

/**
 * Captures browser storage state with a hard timeout.
 *
 * Playwright's storageState() can occasionally wait on a busy Yahoo page. If it
 * does, fall back to reading cookies and localStorage directly. Yahoo auth is
 * cookie-based, so cookies alone are still useful even when localStorage
 * collection fails.
 */
export async function captureStorageState(
  context: BrowserContext,
  timeoutMs: number = 3_000
): Promise<StorageState> {
  const viaPlaywright = await withTimeout(
    context.storageState().catch(() => null),
    timeoutMs
  );
  if (viaPlaywright != null) {
    return viaPlaywright;
  }

  console.warn(
    "storageState() timed out or failed; falling back to cookies/localStorage"
  );

  const cookies = await context.cookies();
  const origins: StorageState["origins"] = [];

  for (const page of context.pages()) {
    try {
      const url = page.url();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        continue;
      }

      const origin = new URL(url).origin;
      const localStorageEntries = await withTimeout(
        page.evaluate(() =>
          Object.entries(localStorage).map(([name, value]) => ({
            name,
            value,
          }))
        ),
        5_000
      );

      if (localStorageEntries != null && localStorageEntries.length > 0) {
        origins.push({ origin, localStorage: localStorageEntries });
      }
    } catch {
      // Best effort; cookies are enough for cookie-based auth.
    }
  }

  return { cookies, origins };
}
