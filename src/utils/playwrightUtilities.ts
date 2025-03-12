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

/**
 * Processes a user agent string to appear as Windows Chrome
 * @param userAgent - Original user agent string
 * @returns Modified user agent string for Windows
 */
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

/**
 * Extracts Chrome version from user agent string
 * @param userAgent - User agent string
 * @param browser - Browser instance as fallback
 * @returns Chrome version
 */
export async function getChromeVersion(userAgent: string, browser: Browser): Promise<string> {
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

/**
 * Generates brand data based on Chrome version
 * @param version - Chrome version
 * @returns Brand data array
 */
export function generateBrandData(version: string): Array<{brand: string, version: string}> {
  const majorVersion = version.split('.')[0];
  
  // Recreate the greasybrand logic similar to Puppeteer plugin
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
  brands[order[0]] = { brand: "Not A Brand", version: "99" };
  brands[order[1]] = { brand: "Chromium", version: majorVersion };
  brands[order[2]] = { brand: "Google Chrome", version: majorVersion };
  
  return brands;
}

/**
 * Generates a Sec-CH-UA header value from brand data
 * @param brands - Array of brand objects with brand and version
 * @returns Properly formatted Sec-CH-UA header value
 */
export function generateSecCHUA(brands: Array<{brand: string, version: string}>): string {
  return brands
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', ');
}

/**
 * Creates a browser context that appears as Chrome running on Windows
 * @param browser - Browser instance to create context from
 * @returns Promise resolving to a configured BrowserContext
 */
export async function createWindowsContext(browser: Browser): Promise<BrowserContext> {
  if (!browser) {
    throw new Error("Browser not initialized");
  }

  // Get the actual browser user agent by creating a temporary context and page
  const tempContext = await browser.newContext();
  const tempPage = await tempContext.newPage();
  const actualUserAgent = await tempPage.evaluate(() => navigator.userAgent);
  await tempPage.close();
  await tempContext.close();
  
  // Process the user agent to ensure it shows as Windows
  const userAgent = processUserAgent(actualUserAgent);
  
  // Extract Chrome version from the user agent
  const chromeVersion = await getChromeVersion(userAgent, browser);
  const brands = generateBrandData(chromeVersion);
  
  // Generate Sec-CH-UA header from brands
  const secCHUA = generateSecCHUA(brands);
  
  // Create the actual context we'll use
  const context = await browser.newContext({
    userAgent,
    viewport: null,
    proxy: await parseProxy(),
    extraHTTPHeaders: {
      'Sec-CH-UA': secCHUA,
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-CH-UA-Mobile': '?0'
    }
  });

  // Use CDP to override platform-specific details
  const cdpPage = await context.newPage();
  const cdpSession = await context.newCDPSession(cdpPage);
  
  await cdpSession.send('Network.setUserAgentOverride', {
    userAgent,
    platform: "Win32",
    userAgentMetadata: {
      brands: brands,
      fullVersion: chromeVersion,
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86_64",
      model: "",
      mobile: false
    },
    acceptLanguage: "en-US,en;q=0.9"
  });

  // Close the temporary page used for CDP session
  await cdpPage.close();
  
  return context;
}
