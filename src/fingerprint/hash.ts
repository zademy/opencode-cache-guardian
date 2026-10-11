import { createHash, createHmac, randomBytes } from "node:crypto"

/**
 * Fingerprints only. There is no reverse path: SHA-256 and HMAC-SHA256 are one-way, so a
 * stored digest can never be replayed back into prompt content.
 */

const HASH_ALGO = "sha256"
export const HMAC_KEY_BYTES = 32

/** Unkeyed digests are dictionary-attackable against known prompt text. HMAC is not. */
export type HashKey = Uint8Array | undefined

export function fingerprint(input: string, key?: HashKey): string {
  return key && key.length > 0
    ? createHmac(HASH_ALGO, key).update(input, "utf8").digest("hex")
    : createHash(HASH_ALGO).update(input, "utf8").digest("hex")
}

/** Block digests are folded into one aggregate, so no per-block value is ever stored. */
export function combine(digests: readonly string[]): string {
  return fingerprint(digests.join("\u0000"))
}

export function generateHashKey(): HashKey {
  return new Uint8Array(randomBytes(HMAC_KEY_BYTES))
}

/** Truncated display form for logs. Never a full digest: logs outlive retention. */
export function shortDigest(hex: string, length = 8): string {
  return hex.slice(0, length)
}
