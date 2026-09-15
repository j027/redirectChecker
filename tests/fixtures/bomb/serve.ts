import http from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

export interface BombFixtureServer {
  /** Base URL of the local fixture origin, e.g. http://127.0.0.1:34567 */
  baseUrl: string;
  /** Every /tick?name=... recorded during the test, in order */
  ticks: string[];
  /** URLs/paths requested from the fixture origin */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves the sanitized bomb fixtures over a local HTTP origin.
 *
 * A real origin is required: patchright injects addInitScript through routes on
 * HTML responses, so file:// or setContent pages would never see the Worker
 * hooks. Everything stays on 127.0.0.1 with no external network access.
 */
export async function startBombFixtureServer(): Promise<BombFixtureServer> {
  const ticks: string[] = [];
  const requests: string[] = [];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(url.pathname + url.search);

      if (url.pathname === "/tick") {
        ticks.push(url.searchParams.get("name") ?? "unknown");
        res.writeHead(204, { "access-control-allow-origin": "*" });
        res.end();
        return;
      }

      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.join(fixtureDir, file);

      if (!filePath.startsWith(fixtureDir)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const data = await readFile(filePath);
      const contentType = file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".js")
          ? "text/javascript"
          : "text/plain";

      res.writeHead(200, {
        "content-type": contentType,
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    ticks,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
