import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { chromium, Browser } from "patchright";
import { trackRedirectionPath } from "../../src/utils/playwrightUtilities.js";

const TEST_TIMEOUT = 30000;

interface FixtureServer {
  baseUrl: string;
  waitForRequest(path: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function html(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const seen: string[] = [];
  const waiters: { path: string; resolve: () => void }[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    seen.push(path);

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].path === path) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }

    const send = (body: string, contentType = "text/html") => {
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      res.end(body);
    };

    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };

    switch (path) {
      case "/start":
        return redirect("/hop");
      case "/hop":
        return redirect("/landing");
      case "/landing":
        return send(
          html(
            '<img src="/pixel" width="1" height="1">' +
              '<script src="/analytics"></script>' +
              '<iframe src="/frame" width="50" height="50"></iframe>' +
              '<iframe src="/iframe-post"></iframe>'
          )
        );
      case "/js-location":
        return send(html('<script>window.location.href="/js-final";</script>'));
      case "/js-replace":
        return send(html('<script>location.replace("/js-final2");</script>'));
      case "/meta":
        return send(
          html('<meta http-equiv="refresh" content="0;url=/meta-final">')
        );
      case "/js-final":
      case "/js-final2":
      case "/meta-final":
      case "/post-landing":
        return send(html("done"));
      case "/post-form":
        return send(
          html(
            '<form id="f" method="POST" action="/post"></form>' +
              '<script>document.getElementById("f").submit();</script>'
          )
        );
      case "/post":
        return redirect("/post-landing");
      case "/fetch-gate":
        return send(
          html(
            '<script>fetch("/gate-api",{method:"POST"}).then(function(){window.location.href="/landing";});</script>'
          )
        );
      case "/gate-api":
        return redirect("/landing");
      case "/pixel":
        return redirect("/tracker/pixel");
      case "/analytics":
        return redirect("/tracker/script");
      case "/frame":
        return redirect("/tracker/frame");
      case "/tracker/frame":
        return send(html('<script>location.href="/tracker/iframe-js";</script>'));
      case "/iframe-post":
        return send(
          html(
            '<form id="g" method="POST" action="/iframe-post-target"></form>' +
              '<script>document.getElementById("g").submit();</script>'
          )
        );
      case "/iframe-post-target":
        return redirect("/tracker/iframe-post");
      default:
        return send("");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    waitForRequest(path: string, timeoutMs = 5000) {
      if (seen.includes(path)) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for fixture request ${path}`));
        }, timeoutMs);

        waiters.push({
          path,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Redirect Path Tracker (main-frame only)", () => {
  let browser: Browser;
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      chromiumSandbox: true,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  });

  async function newPage() {
    const context = await browser.newContext();
    return { context, page: await context.newPage() };
  }

  it(
    "records a main-frame HTTP redirect chain",
    async () => {
      const { context, page } = await newPage();
      const tracker = await trackRedirectionPath(page, `${server.baseUrl}/start`);

      await page.goto(`${server.baseUrl}/start`, { waitUntil: "load" });
      await page.waitForTimeout(500);

      const path = tracker.getPath();
      expect(path).toContain(`${server.baseUrl}/start`);
      expect(path).toContain(`${server.baseUrl}/hop`);
      expect(path).toContain(`${server.baseUrl}/landing`);

      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "records JS location.href and location.replace navigations",
    async () => {
      const locationPage = await newPage();
      const locationTracker = await trackRedirectionPath(
        locationPage.page,
        `${server.baseUrl}/js-location`
      );
      await locationPage.page.goto(`${server.baseUrl}/js-location`);
      await locationPage.page.waitForURL(`${server.baseUrl}/js-final`);
      expect(locationTracker.getPath()).toContain(`${server.baseUrl}/js-final`);
      await locationPage.context.close();

      const replacePage = await newPage();
      const replaceTracker = await trackRedirectionPath(
        replacePage.page,
        `${server.baseUrl}/js-replace`
      );
      await replacePage.page.goto(`${server.baseUrl}/js-replace`);
      await replacePage.page.waitForURL(`${server.baseUrl}/js-final2`);
      expect(replaceTracker.getPath()).toContain(`${server.baseUrl}/js-final2`);
      await replacePage.context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "records a meta refresh navigation",
    async () => {
      const { context, page } = await newPage();
      const tracker = await trackRedirectionPath(page, `${server.baseUrl}/meta`);

      await page.goto(`${server.baseUrl}/meta`);
      await page.waitForURL(`${server.baseUrl}/meta-final`);

      expect(tracker.getPath()).toContain(`${server.baseUrl}/meta-final`);
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "records a form POST that redirects the page",
    async () => {
      const { context, page } = await newPage();
      const tracker = await trackRedirectionPath(
        page,
        `${server.baseUrl}/post-form`
      );

      await page.goto(`${server.baseUrl}/post-form`);
      await page.waitForURL(`${server.baseUrl}/post-landing`);

      const path = tracker.getPath();
      expect(path).toContain(`${server.baseUrl}/post`);
      expect(path).toContain(`${server.baseUrl}/post-landing`);

      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "records the gate page but not its internal fetch API",
    async () => {
      const { context, page } = await newPage();
      const tracker = await trackRedirectionPath(
        page,
        `${server.baseUrl}/fetch-gate`
      );

      await page.goto(`${server.baseUrl}/fetch-gate`);
      await page.waitForURL(`${server.baseUrl}/landing`);
      await page.waitForTimeout(300);

      const path = tracker.getPath();
      expect(path).toContain(`${server.baseUrl}/fetch-gate`);
      expect(path).toContain(`${server.baseUrl}/landing`);
      expect(path).not.toContain(`${server.baseUrl}/gate-api`);

      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "does not record image, script or iframe redirects",
    async () => {
      const { context, page } = await newPage();
      const tracker = await trackRedirectionPath(page, `${server.baseUrl}/start`);

      await page.goto(`${server.baseUrl}/start`, { waitUntil: "load" });

      await server.waitForRequest("/tracker/pixel");
      await server.waitForRequest("/tracker/script");
      await server.waitForRequest("/tracker/frame");
      await page.waitForTimeout(500);

      const trackers = tracker
        .getPath()
        .filter((url) => url.includes("/tracker/"));

      expect(trackers).toEqual([]);
      await context.close();
    },
    TEST_TIMEOUT
  );
});
