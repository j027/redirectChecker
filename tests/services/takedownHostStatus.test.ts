import { describe, expect, it } from "vitest";
import {
  classifyHostStatusResponse,
  matchHostStatusProvider,
} from "../../src/services/takedownMonitorService.js";

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
});
