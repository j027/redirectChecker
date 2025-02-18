import { fetch, ProxyAgent } from "undici";
import { readConfig } from "../config";
import { RedirectType } from "../redirectType";
import { userAgentService } from "./userAgentService";

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
