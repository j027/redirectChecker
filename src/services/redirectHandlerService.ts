import { fetch, ProxyAgent } from "undici";
import { readConfig } from "../config.js";
import { RedirectType } from "../redirectType.js";
import { userAgentService } from "./userAgentService.js";
import { browserRedirectService } from "./browserRedirectService.js";
import { aiClassifierService } from "./aiClassifierService.js";

export async function handleRedirect(
  redirectUrl: string,
  redirectType: RedirectType,
): Promise<[string | null, boolean, Buffer | null, string | null]> {
  let location: string | null = null;
  let isScam = false;
  let screenshot: Buffer | null = null;
  let html: string | null = null;

  // Step 1: Get the destination URL based on redirect type
  switch (redirectType) {
    case RedirectType.HTTP:
      location = await httpRedirect(redirectUrl);
      break;
    case RedirectType.WeeblyDigitalOceanJs:
      location = await weeblyDigitalOceanJs(redirectUrl);
      break;
    case RedirectType.BrowserRedirect:
      location = await browserRedirectService.handleRedirect(redirectUrl);
      break;
    case RedirectType.BrowserRedirectPornhub:
      location = await browserRedirectService.handleRedirect(redirectUrl, "https://www.pornhub.com/");
      break;
    default:
      console.warn(`Redirect type ${redirectType} is not supported yet`);
      throw new Error("Redirect type not supported");
  }

  // If we got a destination URL, classify it
  if (location != null) {
    const classificationResult = await aiClassifierService.classifyUrl(location);
    
    if (classificationResult) {
      isScam = classificationResult.isScam;
      screenshot = classificationResult.screenshot;
      html = classificationResult.html;
      
      // Log classification result
      console.log(`Classified ${location}: ${isScam ? 'SCAM' : 'SAFE'} (confidence: ${classificationResult.confidenceScore})`);
      return [location, isScam, screenshot, html]
    } else {
      // AI classification failed
      console.warn(`AI classification failed for ${location}, assuming it is not a scam`);
      return [location, false, null, null];
    }
  }
  else {
    return [location, false, null, null]
  }
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

async function weeblyDigitalOceanJs(
  redirectUrl: string,
): Promise<string | null> {

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  const weeblyPage = await fetch(redirectUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
  }).then((r) => r.text());

  const digitalOceanRedirectRegex: RegExp =
    /(?<=var redirectUrl = ")https:\/\/.*(?=";)/;
  const nextRedirect = weeblyPage.match(digitalOceanRedirectRegex);

  // if we can't find the next digitalocean redirect
  if (nextRedirect == null || nextRedirect.length == 0) {
    return null;
  }

  // pass onto the standard redirect handling, as it is now a normal http redirect from here
  return httpRedirect(nextRedirect[0]);
}
