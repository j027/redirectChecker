import { describe, it, expect } from "vitest";
import { redactIpFromUrl } from "../../src/utils/urlUtils.js";

describe("redactIpFromUrl", () => {
  // ── IPv4 ──────────────────────────────────────────────────────────────────

  it("redacts an IPv4 address in a query parameter value", () => {
    const result = redactIpFromUrl("https://example.com/path?src=203.0.113.4");
    expect(result).toBe("https://example.com/path?src=%5Bredacted%5D");
  });

  it("redacts IPv4 addresses across multiple query parameters", () => {
    const result = redactIpFromUrl(
      "https://example.com/?a=1.2.3.4&b=clean&c=5.6.7.8"
    );
    const url = new URL(result);
    expect(url.searchParams.get("a")).toBe("[redacted]");
    expect(url.searchParams.get("b")).toBe("clean");
    expect(url.searchParams.get("c")).toBe("[redacted]");
  });

  it("does NOT redact the hostname even when it is an IPv4 address", () => {
    const result = redactIpFromUrl("https://198.51.100.1/page?q=1");
    expect(result).toContain("198.51.100.1");
  });

  it("does not alter a URL with no IP addresses", () => {
    const input = "https://example.com/path?foo=bar&baz=qux";
    expect(redactIpFromUrl(input)).toBe(input);
  });

  it("redacts an IPv4 address embedded inside a longer query value", () => {
    const result = redactIpFromUrl(
      "https://example.com/?ref=from-203.0.113.4-via-proxy"
    );
    const url = new URL(result);
    expect(url.searchParams.get("ref")).toBe("from-[redacted]-via-proxy");
  });

  // ── IPv6 ──────────────────────────────────────────────────────────────────

  it("redacts a full-form IPv6 address in a query parameter value", () => {
    const result = redactIpFromUrl(
      "https://example.com/?ip=2001:0db8:85a3:0000:0000:8a2e:0370:7334"
    );
    const url = new URL(result);
    expect(url.searchParams.get("ip")).toBe("[redacted]");
  });

  it("redacts a compressed IPv6 address (::1) in a query parameter value", () => {
    const result = redactIpFromUrl("https://example.com/?src=::1");
    const url = new URL(result);
    expect(url.searchParams.get("src")).toBe("[redacted]");
  });

  it("redacts a compressed IPv6 address in a query parameter value", () => {
    const result = redactIpFromUrl("https://example.com/?host=2001:db8::1");
    const url = new URL(result);
    expect(url.searchParams.get("host")).toBe("[redacted]");
  });

  it("redacts a bracket-wrapped IPv6 address in a query parameter value", () => {
    const result = redactIpFromUrl("https://example.com/?addr=%5B2001%3Adb8%3A%3A1%5D");
    const url = new URL(result);
    // The decoded value [2001:db8::1] should be redacted
    expect(url.searchParams.get("addr")).toBe("[redacted]");
  });

  it("does NOT redact the IPv6 hostname", () => {
    const result = redactIpFromUrl("https://[2001:db8::1]/page?q=1");
    expect(result).toContain("[2001:db8::1]");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("returns the original string unchanged when the input is not a valid URL", () => {
    const input = "not-a-url";
    expect(redactIpFromUrl(input)).toBe(input);
  });

  it("returns the input unchanged when there are no query parameters", () => {
    const input = "https://example.com/path";
    expect(redactIpFromUrl(input)).toBe(input);
  });

  it("handles a URL with both an IPv4 and IPv6 in separate params", () => {
    const result = redactIpFromUrl(
      "https://example.com/?v4=192.168.1.1&v6=2001:db8::42"
    );
    const url = new URL(result);
    expect(url.searchParams.get("v4")).toBe("[redacted]");
    expect(url.searchParams.get("v6")).toBe("[redacted]");
  });
});
