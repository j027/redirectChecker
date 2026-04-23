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
