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
