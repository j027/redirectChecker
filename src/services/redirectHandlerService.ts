import { fetch, ProxyAgent } from "undici";
import { readConfig } from "../config.js";
import { RedirectType } from "../redirectType.js";
import { userAgentService } from "./userAgentService.js";
import { browserRedirectService } from "./browserRedirectService.js";
import { CapturedRequest } from "../utils/requestLogger.js";

export interface RedirectResult {
  location: string | null;
  requests: CapturedRequest[];
}

export async function handleRedirect(
  redirectUrl: string,
  redirectType: RedirectType,
  captureRequests: boolean = false,
): Promise<RedirectResult> {
  let location: string | null = null;
  let requests: CapturedRequest[] = [];

  // Step 1: Get the destination URL based on redirect type
  switch (redirectType) {
    case RedirectType.HTTP:
      location = await httpRedirect(redirectUrl);
      break;
    case RedirectType.BrowserRedirect:
      ({ destination: location, requests } =
        await browserRedirectService.handleRedirect(redirectUrl, undefined, undefined, captureRequests));
      break;
    case RedirectType.BrowserRedirectPornhub:
      ({ destination: location, requests } =
        await browserRedirectService.handleRedirect(redirectUrl, "https://www.pornhub.com/", undefined, captureRequests));
      break;
    case RedirectType.BrowserRedirectHunterProxy:
      ({ destination: location, requests } =
        await browserRedirectService.handleRedirect(redirectUrl, undefined, true, captureRequests));
      break;
    default:
      console.warn(`Redirect type ${redirectType} is not supported yet`);
      throw new Error("Redirect type not supported");
  }

  return { location, requests };
}

async function httpRedirect(redirectUrl: string): Promise<string | null> {
  const { proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  // check redirect through proxy
  const response = await fetch(redirectUrl, {
    method: "GET",
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
  });

  return response.headers.get("location");
}

