/**
 * Validates whether a string is a well-formed URL.
 */
export function isValidUrl(url: string): boolean {
  try {
    return Boolean(new URL(url));
  } catch {
    return false;
  }
}

/** Tracking parameters stripped from ad destinations so the same landing page
 *  is not treated as a new destination when only tracker params differ. */
const AD_TRACKING_PARAMS = [
  "q",
  "nb",
  "nm",
  "nx",
  "ny",
  "is",
  "_agid",
  "gad_source",
  "rid",
  "gclid",
];

/** Ad-serving utility links that are never the creative's destination. */
const AD_UTILITY_HREF_PATTERN =
  /adssettings\.google|google\.com\/settings\/ads|myadcenter|support\.google|\/privacy/i;

export interface ExtractedAdDestination {
  url: string;
  source: "adurl" | "ds_dest_url" | "raw";
}

export interface ExtractAdDestinationOptions {
  /** Return the href itself when it carries no extractable destination. */
  fallbackToRawHref?: boolean;
  /** Remove known ad tracking parameters from the returned URL. */
  stripTrackingParams?: boolean;
}

function stripAdTrackingParams(url: URL): URL {
  for (const param of AD_TRACKING_PARAMS) {
    url.searchParams.delete(param);
  }
  return url;
}

function resolveDoubleClickDestination(
  url: URL,
  source: "adurl" | "raw"
): ExtractedAdDestination {
  if (
    url.hostname === "ad.doubleclick.net" &&
    url.pathname.startsWith("/searchads/link/click")
  ) {
    const destination = url.searchParams.get("ds_dest_url");
    if (destination != null) {
      return { url: destination, source: "ds_dest_url" };
    }
  }

  return { url: url.toString(), source };
}

/**
 * Extracts the destination a search/AdSense ad link points to.
 *
 * Google click URLs carry the landing page in `adurl`; older DoubleClick
 * search links carry it in `ds_dest_url`. Links that expose neither (network
 * trackers) can be returned as-is when `fallbackToRawHref` is enabled, since
 * navigating the tracker reproduces the real redirect chain.
 */
export function extractAdDestinationUrl(
  href: string,
  options: ExtractAdDestinationOptions = {}
): ExtractedAdDestination | null {
  const { fallbackToRawHref = false, stripTrackingParams = false } = options;

  if (typeof href !== "string" || href.trim() === "") {
    return null;
  }

  if (AD_UTILITY_HREF_PATTERN.test(href)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const adurl = parsed.searchParams.get("adurl");
  if (adurl != null && adurl.trim() !== "") {
    let destination: URL;
    try {
      destination = new URL(decodeURIComponent(adurl));
    } catch {
      return null;
    }

    if (destination.protocol !== "http:" && destination.protocol !== "https:") {
      return null;
    }

    if (stripTrackingParams) {
      stripAdTrackingParams(destination);
    }

    return resolveDoubleClickDestination(destination, "adurl");
  }

  if (!fallbackToRawHref) {
    return null;
  }

  if (stripTrackingParams) {
    stripAdTrackingParams(parsed);
  }

  return resolveDoubleClickDestination(parsed, "raw");
}

// Matches standard IPv4 addresses (strict octet range 0-255)
const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|\d{1,2})\b/g;

// Matches IPv6 addresses including compressed (::1), full, and bracket-wrapped ([::1]) forms.
// Requires at least two colon-separated hex groups to minimise false positives.
const IPV6_REGEX = /\[?(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\]?/g;

/**
 * Redacts IPv4 and IPv6 addresses found in URL query parameter *values*.
 * The hostname is intentionally left unchanged so scam-site destinations
 * remain accurate for external reports.
 * Returns the original string unchanged if the input cannot be parsed as a URL.
 */
export function redactIpFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const redactedParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      const redacted = value
        .replace(IPV4_REGEX, "[redacted]")
        .replace(IPV6_REGEX, "[redacted]");
      redactedParams.append(key, redacted);
    }
    parsed.search = redactedParams.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}
