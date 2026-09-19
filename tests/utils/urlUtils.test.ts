import { describe, it, expect } from "vitest";
import {
  extractAdDestinationUrl,
  redactIpFromUrl,
} from "../../src/utils/urlUtils.js";

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

describe("extractAdDestinationUrl", () => {
  const stripOptions = {
    fallbackToRawHref: true,
    stripTrackingParams: true,
  };

  it("decodes the adurl destination and strips tracking parameters", () => {
    const href =
      "https://www.googleadservices.com/pagead/aclk?sa=L&ai=Cin-7rwOuao3" +
      "&sig=AOD64_0q&client=ca-pub-9560180491300958&nb=0" +
      "&adurl=https://www.chinafy.com/chinafy-vs-cdn%3Fgbraid%3D0AAAAACoFX8miIWq5BxLWPNY8_9tohy-_R" +
      "%26gad_source%3D5%26gad_campaignid%3D21297091895%26gclid%3DEAIaIQobChMIzYHb";

    expect(extractAdDestinationUrl(href, stripOptions)).toEqual({
      url: "https://www.chinafy.com/chinafy-vs-cdn?gbraid=0AAAAACoFX8miIWq5BxLWPNY8_9tohy-_R&gad_campaignid=21297091895",
      source: "adurl",
    });
  });

  it("returns null when there is no adurl and raw fallback is disabled", () => {
    const href = "https://tracker.example/click?tn=1&gclid=abc";
    expect(
      extractAdDestinationUrl(href, {
        fallbackToRawHref: false,
        stripTrackingParams: true,
      }),
    ).toBeNull();
  });

  it("falls back to the raw href when adurl is missing", () => {
    const href = "https://tracenep.admaster.cc/ju/ic?tn=2ce2&gclid=abc";
    expect(extractAdDestinationUrl(href, stripOptions)).toEqual({
      url: "https://tracenep.admaster.cc/ju/ic?tn=2ce2",
      source: "raw",
    });
  });

  it("falls back to the raw href when adurl is empty", () => {
    const href = "https://tracker.example/ic?tn=1&adurl=&gclid=abc";
    expect(extractAdDestinationUrl(href, stripOptions)).toEqual({
      url: "https://tracker.example/ic?tn=1&adurl=",
      source: "raw",
    });
  });

  it("extracts ds_dest_url from DoubleClick search links", () => {
    const href =
      "https://ad.doubleclick.net/searchads/link/click?ds_dest_url=https%3A%2F%2Fscam.example%2Flanding";
    expect(extractAdDestinationUrl(href, stripOptions)).toEqual({
      url: "https://scam.example/landing",
      source: "ds_dest_url",
    });
  });

  it("rejects non-http hrefs", () => {
    for (const href of [
      "javascript:void(0)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:someone@example.com",
      "/landing.html",
      "#",
    ]) {
      expect(extractAdDestinationUrl(href, stripOptions)).toBeNull();
    }
  });

  it("rejects ad utility links", () => {
    expect(
      extractAdDestinationUrl("https://adssettings.google.com/whythisad", stripOptions),
    ).toBeNull();
    expect(
      extractAdDestinationUrl("https://www.google.com/settings/ads", stripOptions),
    ).toBeNull();
  });

  it("rejects an adurl with a non-http destination", () => {
    const href = "https://tracker.example/click?adurl=javascript%3Aalert(1)";
    expect(extractAdDestinationUrl(href, stripOptions)).toBeNull();
  });
});
