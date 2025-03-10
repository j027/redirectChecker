import { Page } from "patchright";
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
  // Block all external images (but allow inline/base64)
  await page.route(/\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)($|\?)/, (route) => {
    route.abort();
  });

  // Block all CSS files
  await page.route(/\.css($|\?)/, (route) => {
    route.abort();
  });

  // Block all video formats
  await page.route(/\.(mp4|webm|ogg|avi|mov|flv|wmv|mkv)($|\?)/, (route) => {
    route.abort();
  });

  // Block all audio formats
  await page.route(/\.(mp3|wav|ogg|aac|flac|m4a)($|\?)/, (route) => {
    route.abort();
  });

  // Block all JavaScript files
  await page.route(/\.js($|\?)/, (route) => {
    route.abort();
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
