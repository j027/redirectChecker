import { Page, Browser, BrowserContext } from "patchright";
import { readConfig } from "../config.js";

export async function blockGoogleAnalytics(page: Page) {
  await page.route("https://www.google-analytics.com/g/collect*", (route) => {
    route.fulfill({
      status: 204,
      body: "",
    });
  });
}

export async function blockPageResources(page: Page) {
  // block all images, fonts, stylesheets, scripts, and media
  await page.route("**/*", (route) => {
    switch(route.request().resourceType()) {
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
}

export async function parseProxy() {
  const { proxy } = await readConfig();

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

/**
 * Performs random mouse movements across the page to simulate human behavior
 * @param page - The Playwright page object
 * @param options - Optional configuration parameters
 * @returns Promise that resolves when all movements are complete
 */
export async function simulateRandomMouseMovements(
  page: Page,
  options: { 
    movements?: number,     // Number of mouse movements to perform
    minDelay?: number,      // Minimum delay between movements in ms
    maxDelay?: number       // Maximum delay between movements in ms
  } = {}
): Promise<void> {
  // Set default values for options
  const movements = options.movements || Math.floor(Math.random() * 4) + 2; // 2-5 movements
  const minDelay = options.minDelay || 100;
  const maxDelay = options.maxDelay || 800;
  
  // Get viewport size
  const viewportSize = page.viewportSize();
  
  if (!viewportSize) {
    console.warn("Could not determine viewport size for mouse movements");
    return;
  }
  
  const { width, height } = viewportSize;
  
  // Current position (start near center)
  let currentX = Math.floor(width / 2);
  let currentY = Math.floor(height / 2);
  
  for (let i = 0; i < movements; i++) {
    // Generate random target position within viewport
    // Avoid edges by using 80% of viewport
    const targetX = Math.floor(Math.random() * (width * 0.8)) + (width * 0.1);
    const targetY = Math.floor(Math.random() * (height * 0.8)) + (height * 0.1);
    
    // Calculate steps based on distance (more steps for longer distances)
    const distance = Math.sqrt(
      Math.pow(targetX - currentX, 2) + Math.pow(targetY - currentY, 2)
    );
    const steps = Math.max(5, Math.floor(distance / 10));
    
    // Perform the mouse movement
    await page.mouse.move(targetX, targetY, { steps });
    
    // Update current position
    currentX = targetX;
    currentY = targetY;
    
    // Random delay before next movement
    if (i < movements - 1) {
      const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
      await page.waitForTimeout(delay);
    }
  }
}
