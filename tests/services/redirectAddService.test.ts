import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/dbPool.js", () => ({
  default: {
    connect: vi.fn(),
  },
}));

vi.mock("../../src/services/hunterService.js", () => ({
  hunterService: {
    tryAddToRedirectChecker: vi.fn(),
  },
}));

import pool from "../../src/dbPool.js";
import { hunterService } from "../../src/services/hunterService.js";
import {
  canAttemptAdd,
  trySightingAdd,
} from "../../src/services/redirectAddService.js";

const mockPoolConnect = vi.mocked(pool.connect);
const mockTryAdd = vi.mocked(hunterService.tryAddToRedirectChecker);

const HOSTNAME = "cloaker.example";
const CLOAKER_URL = "https://cloaker.example/landing";

describe("redirectAddService", () => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue(client as any);
    client.query.mockReset();
    client.release.mockReset();
  });

  describe("canAttemptAdd", () => {
    it("allows an attempt when no row exists", async () => {
      client.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await expect(canAttemptAdd(HOSTNAME)).resolves.toBe(true);
    });

    it("blocks exhausted hostnames", async () => {
      client.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ status: "exhausted", attempts: 3, last_attempt_at: new Date(0) }],
      });

      await expect(canAttemptAdd(HOSTNAME)).resolves.toBe(false);
    });

    it("blocks already added hostnames", async () => {
      client.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ status: "added", attempts: 1, last_attempt_at: new Date(0) }],
      });

      await expect(canAttemptAdd(HOSTNAME)).resolves.toBe(false);
    });

    it("blocks attempts inside the backoff window", async () => {
      client.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ status: "pending", attempts: 1, last_attempt_at: new Date() }],
      });

      await expect(canAttemptAdd(HOSTNAME)).resolves.toBe(false);
    });

    it("allows attempts after the backoff window", async () => {
      client.query.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            status: "pending",
            attempts: 1,
            last_attempt_at: new Date(Date.now() - 31 * 60 * 1000),
          },
        ],
      });

      await expect(canAttemptAdd(HOSTNAME)).resolves.toBe(true);
    });
  });

  describe("trySightingAdd", () => {
    it("records a successful add", async () => {
      client.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      mockTryAdd.mockResolvedValue({ added: true, strategy: "browser_redirect" });
      client.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const result = await trySightingAdd(CLOAKER_URL);

      expect(result).toEqual({
        attempted: true,
        added: true,
        strategy: "browser_redirect",
      });
      expect(mockTryAdd).toHaveBeenCalledWith(CLOAKER_URL);

      const recordParams = client.query.mock.calls[1][1];
      expect(recordParams[0]).toBe(HOSTNAME);
      expect(recordParams[1]).toBe("added");
    });

    it("skips when retries are exhausted", async () => {
      client.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ status: "exhausted", attempts: 3, last_attempt_at: new Date(0) }],
      });

      const result = await trySightingAdd(CLOAKER_URL);

      expect(result).toEqual({ attempted: false, added: false, strategy: null });
      expect(mockTryAdd).not.toHaveBeenCalled();
    });

    it("records a failed attempt so it can retry later", async () => {
      client.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      mockTryAdd.mockResolvedValue({ added: false, strategy: null });
      client.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const result = await trySightingAdd(CLOAKER_URL);

      expect(result).toEqual({ attempted: true, added: false, strategy: null });

      const recordParams = client.query.mock.calls[1][1];
      expect(recordParams[0]).toBe(HOSTNAME);
      expect(recordParams[1]).toBe("pending");
      expect(recordParams[3]).toBe(3);
    });
  });
});
