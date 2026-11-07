import http from "http";

const HEARTBEAT_INTERVAL_MS = 1_000;
const STALE_HEARTBEAT_MS = 5_000;
const DEFAULT_HEALTH_PORT = 3000;

let server: http.Server | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHeartbeat = Date.now();
let discordReady = false;
export type WebGLStatus = "unknown" | "ok" | "failed";
let webglStatus: WebGLStatus = "unknown";
let webglRenderer: string | null = null;

export interface HealthStatus {
  status: "ok" | "stalled";
  uptimeSeconds: number;
  eventLoopStaleMs: number;
  discordReady: boolean;
  webglStatus: WebGLStatus;
  webglRenderer: string | null;
}

export function setDiscordReady(ready: boolean): void {
  discordReady = ready;
}

export function setWebGLStatus(
  status: WebGLStatus,
  renderer?: string | null
): void {
  webglStatus = status;
  webglRenderer = renderer ?? null;
}

function getHealthStatus(): HealthStatus {
  const eventLoopStaleMs = Date.now() - lastHeartbeat;
  return {
    status: eventLoopStaleMs < STALE_HEARTBEAT_MS ? "ok" : "stalled",
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopStaleMs,
    discordReady,
    webglStatus,
    webglRenderer,
  };
}

/**
 * Starts a tiny loopback-only HTTP server for Docker's healthcheck. The
 * heartbeat timer is updated from the event loop, so a blocked event loop
 * makes the endpoint fail even though the process is still alive.
 */
export function startHealthServer(port: number = DEFAULT_HEALTH_PORT): void {
  if (server != null) {
    return;
  }

  lastHeartbeat = Date.now();
  heartbeatTimer = setInterval(() => {
    lastHeartbeat = Date.now();
  }, HEARTBEAT_INTERVAL_MS);

  server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const health = getHealthStatus();
    response.writeHead(health.status === "ok" ? 200 : 503, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(health));
  });

  server.on("error", (error) => {
    console.error("Health server error:", error);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Health server listening on 127.0.0.1:${port}`);
  });
}

export async function stopHealthServer(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const current = server;
  server = null;
  if (current == null) {
    return;
  }

  await new Promise<void>((resolve) => {
    current.close(() => resolve());
  });
}
