import { Browser, BrowserContext, Page } from "patchright";
import {
  BrowserManagerService,
  BrowserRenderer,
  getBrowserRenderer,
} from "./browserManagerService.js";
import { spoofWebGL } from "../utils/playwrightUtilities.js";
import { WebGLConfig } from "../utils/webglConfigs.js";

const SPOOF_TEST_CONFIG: WebGLConfig = {
  vendor: "Google Inc. (NVIDIA)",
  renderer:
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
};

export interface WebGLInfo {
  ok: boolean;
  vendor?: string;
  renderer?: string;
  version?: string;
  maxTextureSize?: number;
  extensionCount?: number;
  error?: string;
}

export interface WebGLHealth {
  status: "ok" | "failed";
  expectedRenderer: BrowserRenderer;
  actualVendor?: string;
  actualRenderer?: string;
  actualVersion?: string;
  maxTextureSize?: number;
  extensionCount?: number;
  spoofedVendor?: string;
  spoofedRenderer?: string;
  rendererMismatch: boolean;
  spoofMismatch: boolean;
  error?: string;
  checkedAt: string;
}

function rendererMatchesExpected(
  renderer: string | undefined,
  expected: BrowserRenderer
): boolean {
  const normalized = (renderer ?? "").toLowerCase();
  if (expected === "mesa") {
    return normalized.includes("llvmpipe") || normalized.includes("mesa");
  }
  return normalized.includes("swiftshader");
}

async function readWebGLInfo(page: Page): Promise<WebGLInfo> {
  // Patchright evaluates page.evaluate() in an isolated world, while
  // spoofWebGL patches the page's main world. Inject a script so the
  // verification sees the same WebGL context the page sees.
  await page.addScriptTag({
    content: `(function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;

        var gl2 = canvas.getContext("webgl2");
        var gl = gl2 || canvas.getContext("webgl");
        if (gl == null) {
          document.documentElement.dataset.webglHealth = JSON.stringify({
            ok: false,
            error: "WebGL context unavailable"
          });
          return;
        }

        var debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        var vendor = String(debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR));
        var renderer = String(debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER));
        var version = String(gl.getParameter(gl.VERSION));
        var maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        var extensionCount = (gl.getSupportedExtensions() || []).length;

        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        var pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        var rendered =
          gl.getError() === gl.NO_ERROR &&
          pixel[0] > 200 &&
          pixel[1] < 50 &&
          pixel[2] < 50 &&
          pixel[3] > 200;

        document.documentElement.dataset.webglHealth = JSON.stringify({
          ok: rendered,
          vendor: vendor,
          renderer: renderer,
          version: version,
          maxTextureSize: maxTextureSize,
          extensionCount: extensionCount,
          error: rendered
            ? undefined
            : "readPixels returned " + Array.prototype.join.call(pixel, ",")
        });
      } catch (error) {
        document.documentElement.dataset.webglHealth = JSON.stringify({
          ok: false,
          error: String(error)
        });
      }
    })();`,
  });

  const raw = await page.evaluate(
    () => document.documentElement.dataset.webglHealth ?? null
  );
  if (raw == null) {
    return { ok: false, error: "WebGL check script did not report a result" };
  }

  try {
    return JSON.parse(raw) as WebGLInfo;
  } catch (error) {
    return {
      ok: false,
      error: `Invalid WebGL check result: ${String(error)}`,
    };
  }
}

async function runWebGLCheck(): Promise<WebGLHealth> {
  const expectedRenderer = getBrowserRenderer();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await BrowserManagerService.createBrowser(false);
    context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await page.goto("data:text/html,<html><body></body></html>");
    const actual = await readWebGLInfo(page);

    await spoofWebGL(page, SPOOF_TEST_CONFIG);
    await page.goto("data:text/html,<html><body></body></html>");
    const spoofed = await readWebGLInfo(page);

    const rendererMismatch = !rendererMatchesExpected(
      actual.renderer,
      expectedRenderer
    );
    const spoofMismatch =
      spoofed.vendor !== SPOOF_TEST_CONFIG.vendor ||
      spoofed.renderer !== SPOOF_TEST_CONFIG.renderer;

    const ok =
      actual.ok &&
      spoofed.ok &&
      !rendererMismatch &&
      !spoofMismatch;

    return {
      status: ok ? "ok" : "failed",
      expectedRenderer,
      actualVendor: actual.vendor,
      actualRenderer: actual.renderer,
      actualVersion: actual.version,
      maxTextureSize: actual.maxTextureSize,
      extensionCount: actual.extensionCount,
      spoofedVendor: spoofed.vendor,
      spoofedRenderer: spoofed.renderer,
      rendererMismatch,
      spoofMismatch,
      error: actual.error ?? spoofed.error,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "failed",
      expectedRenderer,
      rendererMismatch: false,
      spoofMismatch: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/** Verifies WebGL rendering and the fixed WebGL spoof path. */
export async function checkWebGL(): Promise<WebGLHealth> {
  return await runWebGLCheck();
}
