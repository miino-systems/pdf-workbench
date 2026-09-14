import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256, sha256Hex, sha256Text } from '@/crypto';

describe('crypto', () => {
  it('sha256Hex hashes bytes to the expected hex digest', async () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hex = await sha256Hex(new Uint8Array(0));
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256 prefixes the digest with sha256:', async () => {
    const result = await sha256(new Uint8Array(0));
    expect(result).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256Text hashes UTF-8 text', async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const result = await sha256Text('abc');
    expect(result).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256 is deterministic for the same input', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const a = await sha256(bytes);
    const b = await sha256(bytes);
    expect(a).toBe(b);
  });

  it('sha256 differs for different input', async () => {
    const a = await sha256Text('hello');
    const b = await sha256Text('world');
    expect(a).not.toBe(b);
  });

  it('canonicalJson sorts object keys regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('canonicalJson sorts nested object keys and preserves array order', () => {
    const value = { z: [{ y: 1, x: 2 }], a: 1 };
    expect(canonicalJson(value)).toBe('{"a":1,"z":[{"x":2,"y":1}]}');
  });

  it('canonicalJson drops undefined values, like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
