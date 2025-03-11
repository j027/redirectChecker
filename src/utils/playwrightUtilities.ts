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
