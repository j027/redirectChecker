import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrowserRedirectService } from "../../src/services/browserRedirectService.js";
import { BrowserManagerService } from "../../src/services/browserManagerService.js";

const CLOSED_ERROR = new Error(
  "page.evaluate: Target page, context or browser has been closed"
);

describe("BrowserRedirectService restart drain", () => {
  let service: BrowserRedirectService;
  let restartSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new BrowserRedirectService();
    restartSpy = vi
      .spyOn(BrowserManagerService, "forceRestartBrowser")
      .mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for in-flight redirect operations before restarting", async () => {
    (service as any).inFlight = 1;

    const restartPromise = service.restartBrowser();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restartSpy).not.toHaveBeenCalled();

    (service as any).inFlight = 0;
    (service as any).wakeWaiters();
    await restartPromise;

    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it("restarts anyway after the drain timeout", async () => {
    service.drainTimeoutMs = 100;
    (service as any).inFlight = 1;

    await service.restartBrowser();

    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserRedirectService retry on closed browser", () => {
  let service: BrowserRedirectService;

  beforeEach(() => {
    service = new BrowserRedirectService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once when the browser was closed mid-operation", async () => {
    const internalSpy = vi
      .spyOn(service as any, "handleRedirectInternal")
      .mockRejectedValueOnce(CLOSED_ERROR)
      .mockResolvedValueOnce("https://example.com/landing");

    const result = await service.handleRedirect(
      "https://example.com/ad",
      undefined,
      false
    );

    expect(result).toBe("https://example.com/landing");
    expect(internalSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const internalSpy = vi
      .spyOn(service as any, "handleRedirectInternal")
      .mockRejectedValue(new Error("navigation failed"));

    await expect(
      service.handleRedirect("https://example.com/ad", undefined, false)
    ).rejects.toThrow("navigation failed");

    expect(internalSpy).toHaveBeenCalledTimes(1);
  });
});
