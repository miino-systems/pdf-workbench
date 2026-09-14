/**
 * Tiny local SHA-256 helper for the `fonts/` module.
 *
 * `src/crypto` provides the canonical `sha256()` for the rest of the app,
 * but that module is being written in parallel by another agent and must
 * not be imported here (see task instructions), so this is a small,
 * self-contained duplicate using the same Web Crypto API available in both
 * browsers and Node's vitest environment.
 */

/** SHA-256 of `data`, formatted as `sha256:<hex>`. */
export async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  }
  // `subtle.digest` wants an ArrayBuffer/BufferSource; a plain Uint8Array
  // works directly, but copy the view's own bytes to be safe against
  // Uint8Arrays that are a window onto a larger ArrayBuffer.
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
