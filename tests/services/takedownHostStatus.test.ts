import { describe, expect, it } from "vitest";
import {
  classifyHostStatusResponse,
  matchHostStatusProvider,
} from "../../src/services/takedownMonitorService.js";
import {
  formatHostStatusIndicator,
  formatHostStatusReason,
} from "../../src/utils/discordFormatting.js";

describe("takedown host status", () => {
  it("matches Forge and Bunny destinations", () => {
    expect(
      matchHostStatusProvider("https://foo.on-forge.com/path")?.provider
    ).toBe("forge");
    expect(
      matchHostStatusProvider("https://foo.b-cdn.net/path")?.provider
    ).toBe("bunny");
  });

  it("does not match unrelated hosts", () => {
    expect(matchHostStatusProvider("https://example.com/")).toBeNull();
    expect(matchHostStatusProvider("https://noton-forge.com/")).toBeNull();
  });

  it("classifies Forge 451 as a confirmed suspension", () => {
    const provider = matchHostStatusProvider("https://foo.on-forge.com/");
    expect(provider).not.toBeNull();

    const result = classifyHostStatusResponse(
      provider!,
      451,
      "https://suspended.on-forge.com/",
      ""
    );

    expect(result).toMatchObject({
      kind: "suspended_confirmed",
      provider: "forge",
      reason: "legal_451",
    });
  });

  it("classifies the Forge suspension host even with a 200", () => {
    const provider = matchHostStatusProvider("https://foo.on-forge.com/");
    expect(provider).not.toBeNull();

    const result = classifyHostStatusResponse(
      provider!,
      200,
      "https://suspended.on-forge.com/",
      ""
    );

    expect(result?.kind).toBe("suspended_confirmed");
  });

  it("classifies Bunny 403 with the suspended/not-configured marker", () => {
    const provider = matchHostStatusProvider("https://foo.b-cdn.net/");
    expect(provider).not.toBeNull();

    const result = classifyHostStatusResponse(
      provider!,
      403,
      "https://foo.b-cdn.net/",
      "The pull zone is suspended or not configured"
    );

    expect(result).toMatchObject({
      kind: "unavailable",
      provider: "bunny",
      reason: "suspended_or_not_configured",
    });
  });

  it("does not classify a generic Bunny 403", () => {
    const provider = matchHostStatusProvider("https://foo.b-cdn.net/");
    expect(provider).not.toBeNull();

    expect(
      classifyHostStatusResponse(
        provider!,
        403,
        "https://foo.b-cdn.net/",
        "Forbidden"
      )
    ).toBeNull();
  });

  it("does not classify a Forge 500", () => {
    const provider = matchHostStatusProvider("https://foo.on-forge.com/");
    expect(provider).not.toBeNull();

    expect(
      classifyHostStatusResponse(
        provider!,
        500,
        "https://foo.on-forge.com/",
        ""
      )
    ).toBeNull();
  });

  it("classifies Azure FD 404 as gone", () => {
    const provider = matchHostStatusProvider(
      "https://foo.z03.azurefd.net/"
    );
    expect(provider?.provider).toBe("azurefd");

    const result = classifyHostStatusResponse(
      provider!,
      404,
      "https://foo.z03.azurefd.net/",
      ""
    );

    expect(result).toMatchObject({
      kind: "gone",
      provider: "azurefd",
      reason: "http_404",
    });
  });

  it("only treats 404 as gone for Azure FD", () => {
    const provider = matchHostStatusProvider("https://foo.z03.azurefd.net/");
    expect(provider).not.toBeNull();

    expect(
      classifyHostStatusResponse(
        provider!,
        410,
        "https://foo.z03.azurefd.net/",
        ""
      )
    ).toBeNull();
    expect(
      classifyHostStatusResponse(
        provider!,
        200,
        "https://foo.z03.azurefd.net/",
        ""
      )
    ).toBeNull();
  });

  it("labels Azure FD 404 as ambiguous gone", () => {
    expect(formatHostStatusIndicator("gone", "azurefd")).toEqual({
      emoji: "🛑",
      label: "Azure FD gone",
    });
    expect(formatHostStatusReason("gone", "http_404")).toBe(
      "HTTP 404, ambiguous"
    );
  });
});
