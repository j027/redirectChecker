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

/**
 * Additional rotating click/campaign identifiers used only when building a
 * dedupe key. These are intentionally not part of AD_TRACKING_PARAMS because
 * stripping them from the navigation URL can change where the ad lands.
 */
const AD_DEDUPE_TRACKING_PARAMS = new Set([
  ...AD_TRACKING_PARAMS,
  "extclickid",
  "t1",
  "t2",
  "adposition",
  "adid",
  "matchtype",
  "match_type",
  "campid",
  "target",
  "campaign",
  "adgroup",
  "creative",
  "placement",
  "term",
  "source",
  "network",
  "device",
  "device_type",
  "keyword",
  "adgroupid",
  "campaignid",
  "creativeid",
  "creative_id",
  "adgroup_id",
  "campaign_id",
  "ad_id",
  "keyword_id",
  "cid",
  "gad_campaignid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "fbclid",
  "ttclid",
  "twclid",
  "yclid",
  "srsltid",
  "tblci",
  "gad",
]);

/** Ad-serving utility links that are never the creative's destination. */
const AD_UTILITY_HREF_PATTERN =
  /adssettings\.google|google\.com\/settings\/ads|myadcenter|support\.google|\/privacy/i;

export interface ExtractedAdDestination {
  url: string;
  source: "adurl" | "ds_dest_url" | "maxdest" | "redir" | "raw";
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

/**
 * Builds a stable key for deduplicating an ad destination across cycles.
 *
 * Ad click URLs often carry rotating identifiers (`extclickid`, `gclid`,
 * campaign IDs, etc.) that change on every impression even though the landing
 * page is identical. This helper removes those identifiers while preserving
 * path and meaningful query parameters. It must only be used for comparisons;
 * navigating the returned URL could drop parameters the landing page needs.
 */
export function canonicalizeAdDestinationForDedupe(raw: string): string {
  try {
    const url = new URL(raw);
    for (const param of AD_DEDUPE_TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower.startsWith("hsa_") ||
        lower.startsWith("smb_")
      ) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function resolveDoubleClickDestination(
  url: URL,
  source: "adurl" | "maxdest" | "redir" | "raw"
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
 * Parses an embedded destination value. `URLSearchParams` already decodes one
 * layer, but some ad servers double-encode, so try the value as-is first and
 * only fall back to a second decode when the first parse fails.
 */
function parseEmbeddedDestination(value: string): URL | null {
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) {
      candidates.push(decoded);
    }
  } catch {
    // Keep the raw candidate; malformed percent escapes are not a destination.
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

/**
 * Some click servers (notably Criteo) put the landing page in a `maxdest`
 * query parameter. When present, the destination can be read without making
 * a billable click.
 */
function extractMaxdestDestination(
  url: URL,
  stripTrackingParams: boolean
): ExtractedAdDestination | null {
  const maxdest = url.searchParams.get("maxdest");
  if (maxdest == null || maxdest.trim() === "") {
    return null;
  }

  const destination = parseEmbeddedDestination(maxdest);
  if (destination == null) {
    return null;
  }

  if (stripTrackingParams) {
    stripAdTrackingParams(destination);
  }

  return resolveDoubleClickDestination(destination, "maxdest");
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

  const maxdest = extractMaxdestDestination(parsed, stripTrackingParams);
  if (maxdest != null) {
    return maxdest;
  }

  const redir = parsed.searchParams.get("redir");
  if (redir != null && redir.trim() !== "") {
    const destination = parseEmbeddedDestination(redir);
    if (destination != null) {
      if (stripTrackingParams) {
        stripAdTrackingParams(destination);
      }
      return resolveDoubleClickDestination(destination, "redir");
    }
  }

  const adurl = parsed.searchParams.get("adurl");
  if (adurl != null && adurl.trim() !== "") {
    const destination = parseEmbeddedDestination(adurl);
    if (destination == null) {
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

/**
 * Unwraps a Yahoo click wrapper of the form:
 *   https://pn.ybp.yahoo.com/cj/cd/<token>/rurl/<destination>
 *
 * The destination is followed by Yahoo's own query string and fragment. Those
 * are reattached because `?tblci=...` is the Taboola click token, not part of
 * the wrapped URL's path.
 *
 * Returns null when the URL is not a Yahoo /rurl/ wrapper.
 */
export function unwrapYahooClickUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.hostname !== "yahoo.com" && !url.hostname.endsWith(".yahoo.com")) {
    return null;
  }

  const marker = "/rurl/";
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let destination = url.pathname.slice(markerIndex + marker.length);
  if (destination.trim() === "") {
    return null;
  }

  if (!/^https?:\/\//i.test(destination)) {
    try {
      destination = decodeURIComponent(destination);
    } catch {
      return null;
    }
  }

  if (url.search) {
    destination += destination.includes("?") ? `&${url.search.slice(1)}` : url.search;
  }
  destination += url.hash;

  try {
    const parsed = new URL(destination);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return destination;
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
