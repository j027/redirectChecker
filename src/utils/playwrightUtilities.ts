import { Page, Browser, BrowserContext, Frame, Request, Response } from "patchright";
import { readConfig } from "../config.js";
import crypto from 'crypto';

export async function blockGoogleAnalytics(page: Page) {
  await page.route("https://www.google-analytics.com/g/collect*", (route) => {
    route.fulfill({
      status: 204,
      body: "",
    });
  });
}

export async function blockPageResources(page: Page) {
  try {
    // attempt using playwright handlers first
    // block all images, fonts, stylesheets, scripts, and media
    await page.route("**/*", (route) => {
      switch (route.request().resourceType()) {
        case "image":
        case "font":
        case "stylesheet":
        case "script":
        case "media":
          route.abort();
          break;
        default:
          route.continue();
      }
    });

    // TODO: remove this if the playwright resource blocking continues to be stable
    // There was a time when playwright resource blocking stopped working, and I had to use cdp
    // it turns out that's not an issue anymore, but if it comes back just uncomment code below
    // HACK: use cdp too because playwright route handlers don't work properly and idk why
    //const client = await page.context().newCDPSession(page);

    // await client.send("Network.enable");
    // await client.send("Fetch.enable", {
    //   patterns: [
    //     { urlPattern: "*", resourceType: "Image", requestStage: "Request" },
    //     { urlPattern: "*", resourceType: "Font", requestStage: "Request" },
    //     {
    //       urlPattern: "*",
    //       resourceType: "Stylesheet",
    //       requestStage: "Request",
    //     },
    //     { urlPattern: "*", resourceType: "Script", requestStage: "Request" },
    //     { urlPattern: "*", resourceType: "Media", requestStage: "Request" },
    //   ],
    // });

    // client.on("Fetch.requestPaused", async (event) => {
    //   await client.send("Fetch.failRequest", {
    //     requestId: event.requestId,
    //     errorReason: "BlockedByClient",
    //   });
    // });
  } catch (error) {
    console.error(`Failed to set up resource blocking: ${error}`);
  }
}

export async function parseProxy(isHunterProxy = false): Promise<{server: string, username?: string, password?: string}> {
  const config = await readConfig();
  const proxy = isHunterProxy ? config.hunterProxy : config.proxy;

  // Parse proxy URL to extract username and password
  let server = proxy;
  let username = undefined;
  let password = undefined;

  try {
    const proxyUrl = new URL(proxy);

    // Check if there are auth credentials in the URL
    if (proxyUrl.username || proxyUrl.password) {
      username = decodeURIComponent(proxyUrl.username);
      password = decodeURIComponent(proxyUrl.password);

      // Reconstruct proxy URL without auth for server parameter
      server = `${proxyUrl.protocol}//${proxyUrl.host}${proxyUrl.pathname}${proxyUrl.search}`;
    }
  } catch (err) {
    console.error(`Failed to parse proxy URL: ${err}`);
  }

  return { server, username, password };
}

// most of the code below is based on puppeteer extra stealth
// https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth/evasions

export function processUserAgent(userAgent: string): string {
  // Strip headless identifier if present
  let ua = userAgent.replace('HeadlessChrome/', 'Chrome/');
  
  // Replace any platform info with Windows
  if (ua.includes('Linux') && !ua.includes('Android')) {
    ua = ua.replace(/\(([^)]+)\)/, '(Windows NT 10.0; Win64; x64)');
  } else if (ua.includes('Mac OS X')) {
    ua = ua.replace(/\(([^)]+)\)/, '(Windows NT 10.0; Win64; x64)');
  }
  
  return ua;
}


async function getChromeVersion(userAgent: string, browser: Browser): Promise<string> {
  // Try to extract from user agent first
  const uaMatch = userAgent.match(/Chrome\/([\d|.]+)/);
  if (uaMatch && uaMatch[1]) {
    return uaMatch[1];
  }
  
  // Fallback to browser version
  const version = browser.version();
  const versionMatch = version.match(/\/([\d|.]+)/);
  return versionMatch && versionMatch[1] ? versionMatch[1] : '133.0.0.0';
}

function generateBrandData(version: string): Array<{brand: string, version: string}> {
  const majorVersion = version.split('.')[0];
  
  const seed = parseInt(majorVersion, 10);
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ][seed % 6];
  
  // Create placeholder for brands
  const brands = new Array(3);
  
  // Fill in the brands according to the calculated order
  brands[order[0]] = { brand: "Not A Brand", version: "24" };
  brands[order[1]] = { brand: "Chromium", version: majorVersion };
  brands[order[2]] = { brand: "Google Chrome", version: majorVersion };
  
  return brands;
}

// Type definitions for WebGL spoofing
interface WebGLConfig {
  vendor: string;
  renderer: string;
}

// Common Windows WebGL configurations
const WEBGL_CONFIGS: WebGLConfig[] = [
  // Intel configurations
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  
  // NVIDIA configurations
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  
  // AMD configurations
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 550 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 560 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 570 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 5500 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 5600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  
  // Laptop integrated/mobile GPUs
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce MX350 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon RX Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (AMD, AMD Radeon 680M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];


export async function spoofWebGL(
  page: Page,
  config?: WebGLConfig
): Promise<void> {
  // If no specific config is provided, pick a random one
  const webGLConfig = config || WEBGL_CONFIGS[Math.floor(Math.random() * WEBGL_CONFIGS.length)];
  
  await page.addInitScript(({ vendor, renderer }) => {
    const getParameterProxyHandler = {
      apply: function(
        target: (pname: number) => any, 
        ctx: any, 
        args: any[]
      ): any {
        const param = (args || [])[0];
        const result = Reflect.apply(target, ctx, args);
        // UNMASKED_VENDOR_WEBGL
        if (param === 37445) {
          return vendor;
        }
        // UNMASKED_RENDERER_WEBGL
        if (param === 37446) {
          return renderer;
        }
        return result;
      }
    };

    // Add proxies for both WebGL rendering contexts
    if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype) {
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = new Proxy(originalGetParameter, getParameterProxyHandler);
    }
    
    if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype) {
      const originalGetParameter = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = new Proxy(originalGetParameter, getParameterProxyHandler);
    }
  }, webGLConfig);
}

// Update the spoofWindowsChrome function to include WebGL spoofing
export async function spoofWindowsChrome(context: BrowserContext, page: Page): Promise<void> {
  const actualUserAgent = await page.evaluate(() => navigator.userAgent);
  
  // Process the user agent to ensure it shows as Windows
  const userAgent = processUserAgent(actualUserAgent);
  
  const browser = context.browser();

  if (browser == null) {
    console.log("Browser is not initialized in the expected way - failed to create the windows context");
    return;
  }

  // Extract Chrome version from the user agent
  const chromeVersion = await getChromeVersion(userAgent, browser);
  const brands = generateBrandData(chromeVersion);
  const cdpSession = await context.newCDPSession(page);
  
  await cdpSession.send('Network.setUserAgentOverride', {
    userAgent,
    platform: "Win32",
    acceptLanguage: 'en-US,en',
    userAgentMetadata: {
      brands: brands,
      fullVersion: chromeVersion,
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86",
      model: "",
      mobile: false
    }
  });
  
  // Add WebGL spoofing with a random Windows-compatible configuration
  await spoofWebGL(page);
}

export async function simulateRandomMouseMovements(
  page: Page,
  options = { maxX: 500, maxY: 500, minDrags: 3, maxDrags: 7 }
): Promise<void> {
  // Determine number of random drag operations
  const dragCount = crypto.randomInt(options.minDrags, options.maxDrags + 1);
  
  for (let i = 0; i < dragCount; i++) {
    const startX = crypto.randomInt(options.maxX + 1);
    const startY = crypto.randomInt(options.maxY + 1);
    await page.mouse.move(startX, startY);
    
    // Press mouse down to start dragging
    await page.mouse.down();
    
    // Make 3-6 random movements while dragging
    const moveCount = crypto.randomInt(3, 7);
    
    for (let j = 0; j < moveCount; j++) {
      const nextX = crypto.randomInt(options.maxX + 1);
      const nextY = crypto.randomInt(options.maxY + 1);
      
      await page.waitForTimeout(crypto.randomInt(50, 151));
      await page.mouse.move(nextX, nextY);
    }
    
    // Release mouse button to end drag
    await page.mouse.up();
    await page.waitForTimeout(crypto.randomInt(200, 501));
  }
}

export async function trackRedirectionPath(page: Page, startUrl: string) {
  const redirectionPath: Set<string> = new Set();
  redirectionPath.add(startUrl);

  // This optional helper decides if we should record a URL
  function shouldRecord(url: string, resourceType?: string) {
    // Filter out known junk patterns and non-navigation resource types
    if (
      resourceType &&
      ["image", "font", "media", "stylesheet", "script"].includes(resourceType)
    ) {
      return false;
    }
    if (url.includes(".gif") || url.includes(".js")) {
      return false;
    }
    return true;
  }

  // ------------------------------
  // 1) CDP Setup for lower-level event tracking
  // ------------------------------
  try {
    const cdpClient = await page.context().newCDPSession(page);
    await cdpClient.send("Network.enable");
    console.log("[CDP] Network enabled; starting to track requests.");

    // Fires when a request is about to be sent
    cdpClient.on("Network.requestWillBeSent", (event) => {
      const url = event.request.url;
      console.log(`[CDP] requestWillBeSent -> ${url}`);

      // If this request was triggered by a redirect
      if (event.redirectResponse && event.redirectResponse.headers) {
        const headers = event.redirectResponse.headers;
        // Try to find 'Location' header
        const locationKey = Object.keys(headers).find((k) => k.toLowerCase() === "location");
        if (locationKey) {
          const locValue = headers[locationKey];
          try {
            const redirectUrl = new URL(locValue, event.redirectResponse.url).toString();
            console.log(`[CDP] Found redirect in requestWillBeSent -> ${redirectUrl}`);
            if (shouldRecord(redirectUrl)) {
              redirectionPath.add(redirectUrl);
            }
          } catch (err) {
            console.error("[CDP] Failed to parse redirect URL in requestWillBeSent", err);
          }
        }
      }
    });

    // Fires when a response is received (headers available)
    cdpClient.on("Network.responseReceived", (event) => {
      const { url, status, headers } = event.response;
      console.log(`[CDP] responseReceived -> ${url} (status: ${status})`);

      if (status >= 300 && status < 400 && headers.location) {
        try {
          const fullUrl = new URL(headers.location, url).toString();
          console.log(`[CDP] Found redirect response -> ${fullUrl}`);
          if (shouldRecord(fullUrl)) {
            redirectionPath.add(fullUrl);
          }
        } catch (err) {
          console.error("[CDP] Failed to parse location in responseReceived", err);
        }
      }
    });
  } catch (err) {
    console.error("[CDP] Failed to enable network tracking:", err);
  }

  // ------------------------------
  // 2) Existing Playwright Listeners
  // ------------------------------

  const responseListener = async (response: Response) => {
    const status = response.status();
    const respUrl = response.url();
    console.log(`[DEBUG] Playwright.response -> ${respUrl} (status: ${status})`);

    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      if (location) {
        try {
          const fullUrl = new URL(location, respUrl).toString();
          console.log(`[DEBUG] Found redirect (responseListener) -> ${fullUrl}`);
          if (shouldRecord(fullUrl)) {
            redirectionPath.add(fullUrl);
          }
        } catch (err) {
          console.error(`[DEBUG] Failed to parse location in responseListener`, err);
        }
      }
    }
  };

  const navigationListener = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      const url = frame.url();
      console.log(`[DEBUG] Main frame navigated -> ${url}`);
      if (shouldRecord(url)) {
        redirectionPath.add(url);
      }
    }
  };

  const requestListener = (request: Request) => {
    if (request.frame() === page.mainFrame() && request.isNavigationRequest()) {
      console.log(`[DEBUG] Playwright.request -> ${request.url()}`);

      // Build redirect chain backward
      const chain: string[] = [];
      let current: Request | null = request;
      while (current) {
        chain.push(current.url());
        current = current.redirectedFrom();
      }
      chain.reverse().forEach((url) => {
        console.log(`[DEBUG] Redirect chain item -> ${url}`);
        if (shouldRecord(url)) {
          redirectionPath.add(url);
        }
      });
    }
  };

  page.on("response", responseListener);
  page.on("framenavigated", navigationListener);
  page.on("request", requestListener);

  return {
    getPath: () => Array.from(redirectionPath),
  };
}
