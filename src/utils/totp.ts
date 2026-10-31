import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface TotpOptions {
  /** Number of digits in the generated code. Default 6. */
  digits?: number;
  /** Time step in seconds. Default 30. */
  period?: number;
  /** Unix timestamp in milliseconds. Default now. */
  timestamp?: number;
}

/**
 * Extracts and normalizes a base32 TOTP secret. Accepts either a raw base32
 * secret or an `otpauth://` URI.
 */
export function normalizeTotpSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("TOTP secret is empty");
  }

  const otpauthMatch = trimmed.match(/[?&]secret=([^&]+)/i);
  const raw = otpauthMatch?.[1] ?? trimmed;
  const secret = raw
    .replace(/[\s-]/g, "")
    .replace(/=+$/g, "")
    .toUpperCase();

  if (secret === "" || !/^[A-Z2-7]+$/.test(secret)) {
    throw new Error("TOTP secret is not valid base32");
  }

  return secret;
}

/** Decodes an RFC 4648 base32 string (no padding required). */
export function decodeBase32(input: string): Buffer {
  const secret = normalizeTotpSecret(input);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of secret) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generates an RFC 6238 TOTP code using HMAC-SHA1.
 *
 * This deliberately implements the small algorithm directly instead of
 * pulling in a dependency; it is covered by the RFC 6238 test vectors.
 */
export function generateTotp(input: string, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const timestamp = options.timestamp ?? Date.now();

  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new Error(`Invalid TOTP digits: ${digits}`);
  }
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`Invalid TOTP period: ${period}`);
  }

  const key = decodeBase32(input);
  const counter = Math.floor(timestamp / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto
    .createHmac("sha1", key)
    .update(counterBuffer)
    .digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  const code = binary % 10 ** digits;
  return String(code).padStart(digits, "0");
}
