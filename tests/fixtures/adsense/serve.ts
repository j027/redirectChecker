import http from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

export interface AdsenseFixtureServer {
  /** Base URL of the local fixture origin, e.g. http://127.0.0.1:34567 */
  baseUrl: string;
  /** Paths requested from the fixture origin */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves the mock GPT pages over a local HTTP origin. Friendly ad iframes are
 * created with document.write in the fixtures, mirroring how GPT renders them,
 * so frame enumeration and DOM reads behave like the real pages.
 */
export async function startAdsenseFixtureServer(): Promise<AdsenseFixtureServer> {
  const requests: string[] = [];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(url.pathname);

      const file = url.pathname === "/" ? "popup.html" : url.pathname.slice(1);
      const filePath = path.join(fixtureDir, file);

      if (!filePath.startsWith(fixtureDir)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const data = await readFile(filePath);
      res.writeHead(200, {
        "content-type": "text/html",
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
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
