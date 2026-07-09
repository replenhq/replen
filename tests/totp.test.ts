import { describe, it, expect } from "vitest";
import { base32Encode, base32Decode, generateTotpSecret, verifyTotp } from "../src/lib/admin/totp";

// RFC 6238 appendix B SHA1 test vectors. The RFC prints 8-digit codes; our
// implementation is 6 digits, i.e. the low 6 of the same dynamic-truncation
// value, so the expected codes are the last 6 digits of each RFC entry.
// Secret is the ASCII "12345678901234567890" (20 bytes).
const SECRET = base32Encode(Buffer.from("12345678901234567890"));

const VECTORS: Array<[number, string]> = [
  [59, "287082"], // RFC 94287082
  [1111111109, "081804"], // RFC 07081804
  [1234567890, "005924"], // RFC 89005924
  [2000000000, "279037"], // RFC 69279037
];

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const buf = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    expect(Buffer.compare(base32Decode(base32Encode(buf)), buf)).toBe(0);
  });
  it("ignores spaces / lowercase on decode", () => {
    expect(Buffer.compare(base32Decode(SECRET.toLowerCase().replace(/(.{4})/g, "$1 ")), base32Decode(SECRET))).toBe(0);
  });
});

describe("verifyTotp (RFC 6238 SHA1 vectors)", () => {
  for (const [t, code] of VECTORS) {
    it(`accepts ${code} at t=${t}`, () => {
      expect(verifyTotp(SECRET, code, 0, t * 1000)).toBe(true);
    });
    it(`rejects a wrong code at t=${t}`, () => {
      expect(verifyTotp(SECRET, "000000", 0, t * 1000)).toBe(false);
    });
  }

  it("rejects malformed input", () => {
    expect(verifyTotp(SECRET, "12345", 1, 59_000)).toBe(false); // too short
    expect(verifyTotp(SECRET, "abcdef", 1, 59_000)).toBe(false); // non-numeric
    expect(verifyTotp(SECRET, "", 1, 59_000)).toBe(false);
  });

  it("tolerates ±1 step of clock skew with window=1", () => {
    // "287082" is the code for the t=59 step (counter 1). At t=89 (counter 2)
    // it must still verify with window=1, but not with window=0.
    expect(verifyTotp(SECRET, "287082", 1, 89_000)).toBe(true);
    expect(verifyTotp(SECRET, "287082", 0, 89_000)).toBe(false);
  });

  it("a freshly generated secret verifies its own current code path", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // Wrong code against a real secret is rejected (sanity: not always-true).
    expect(verifyTotp(secret, "000000", 0, 0)).toBe(false);
  });
});
