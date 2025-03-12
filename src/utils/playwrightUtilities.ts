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
      architecture: "x86_64",
      model: "",
      mobile: false
    }
  });
}
