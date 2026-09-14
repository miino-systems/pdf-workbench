/**
 * Web Crypto based hashing helpers, plus a canonical JSON serialiser used by
 * the history hash chain.
 *
 * Uses `globalThis.crypto.subtle`, which is available both in browsers and in
 * Node 22+ (used by vitest), so no polyfill is required.
 */

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 digest of binary data, as a lowercase hex string (no prefix).
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = data instanceof Uint8Array ? toArrayBuffer(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
}

/**
 * SHA-256 digest of binary data, formatted as `sha256:<hex>` — the canonical
 * representation stored throughout the app (job records, history events...).
 */
export async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(data)}`;
}

/**
 * SHA-256 digest of a UTF-8 encoded string, formatted as `sha256:<hex>`.
 */
export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256(bytes);
}

/** Copy a Uint8Array's bytes into a plain ArrayBuffer (handles subarrays / views). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Recursively sort object keys so that JSON.stringify produces a stable,
 * deterministic representation regardless of insertion order. Arrays keep
 * their order; `undefined` values are dropped (matching JSON.stringify's own
 * behaviour for object properties).
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) continue;
      sorted[key] = sortValue(input[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialise a JSON-compatible value with stable key ordering, so that two
 * semantically-equal objects always produce the same string. Used as the
 * input to the history hash chain.
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortValue(obj));
}
