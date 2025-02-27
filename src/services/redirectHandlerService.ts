import { fetch, ProxyAgent } from "undici";
import { readConfig } from "../config.js";
import { RedirectType } from "../redirectType.js";
import { userAgentService } from "./userAgentService.js";

export async function handleRedirect(
  redirectUrl: string,
  regex: RegExp,
  redirectType: RedirectType,
): Promise<[string | null, boolean]> {
  let location: string | null = null;

  switch (redirectType) {
    case RedirectType.HTTP:
      location = await httpRedirect(redirectUrl);
      break;
    case RedirectType.BrowserFingerprintPost:
      location = await browserFingerprintPost(redirectUrl);
      break;
    case   RedirectType.WeeblyDigitalOceanJs:
      location = await weeblyDigitalOceanJs(redirectUrl);
      break;
    default:
      console.warn(`Redirect type ${redirectType} is supported yet`);
      throw new Error("Redirect type is supported");
  }

  return [location, location != null ? regex.test(location) : false];
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

async function browserFingerprintPost(
  redirectUrl: string,
): Promise<string | null> {
  const { proxy, browserFingerprintForRedirect } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  // add the magical fingerprint that allows the redirect to work
  const data = new URLSearchParams();
  data.append("data", JSON.stringify(browserFingerprintForRedirect));

  const response = await fetch(redirectUrl, {
    method: "POST",
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
    body: data,
  });

  return response.headers.get("location");
}

async function weeblyDigitalOceanJs(redirectUrl: string) : Promise<string | null> {
  const { proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  const weeblyPage = await fetch(redirectUrl, {
    method: "GET",
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
  }).then(r => r.text());

  const digitalOceanRedirectRegex : RegExp = /(?<=var redirectUrl = ")https:\/\/.*(?=";)/;
  const nextRedirect = weeblyPage.match(digitalOceanRedirectRegex);

  // if we can't find the next digitalocean redirect
  if (nextRedirect == null || nextRedirect.length == 0) {
    return null;
  }

  // pass onto the standard redirect handling, as it is now a normal http redirect from here
  return httpRedirect(nextRedirect[0]);

}
