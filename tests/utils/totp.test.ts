import { describe, it, expect } from "vitest";
import {
  decodeBase32,
  generateTotp,
  normalizeTotpSecret,
} from "../../src/utils/totp.js";

// RFC 6238 test secret: ASCII "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("normalizeTotpSecret", () => {
  it("accepts a raw base32 secret", () => {
    expect(normalizeTotpSecret(RFC_SECRET)).toBe(RFC_SECRET);
  });

  it("strips spaces, hyphens, padding, and case", () => {
    expect(normalizeTotpSecret("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====")).toBe(
      RFC_SECRET
    );
  });

  it("extracts the secret from an otpauth URI", () => {
    expect(
      normalizeTotpSecret(
        `otpauth://totp/Yahoo:user@example.com?secret=${RFC_SECRET}&issuer=Yahoo`
      )
    ).toBe(RFC_SECRET);
  });

  it("rejects invalid base32", () => {
    expect(() => normalizeTotpSecret("not-base32!")).toThrow();
    expect(() => normalizeTotpSecret("")).toThrow();
  });
});

describe("decodeBase32", () => {
  it("decodes the RFC test secret", () => {
    expect(decodeBase32(RFC_SECRET).toString()).toBe("12345678901234567890");
  });
});

describe("generateTotp", () => {
  // RFC 6238 SHA-1 vectors (8 digits).
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [timeSeconds, expected] of vectors) {
    it(`matches the RFC vector at ${timeSeconds}`, () => {
      expect(
        generateTotp(RFC_SECRET, {
          digits: 8,
          timestamp: timeSeconds * 1000,
        })
      ).toBe(expected);
    });
  }

  it("generates six digits by default", () => {
    const code = generateTotp(RFC_SECRET, { timestamp: 59_000 });
    expect(code).toBe("287082");
    expect(code).toHaveLength(6);
  });

  it("supports a six-digit slice of the RFC vector", () => {
    expect(
      generateTotp(RFC_SECRET, { digits: 6, timestamp: 1_111_111_109_000 })
    ).toBe("081804");
  });

  it("rejects invalid digit and period settings", () => {
    expect(() => generateTotp(RFC_SECRET, { digits: 0 })).toThrow();
    expect(() => generateTotp(RFC_SECRET, { period: 0 })).toThrow();
  });
});
