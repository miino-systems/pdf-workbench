/**
 * A short fingerprint of everything in stamps.json that affects a
 * generated PDF: the enabled placements and the definitions they use.
 * Recorded with each job so an output made with since-changed stamps can
 * be flagged as stale. Font `sha256` bookkeeping (filled in after a run)
 * and disabled placements are left out, so they don't mark outputs stale.
 */
import type { StampsConfig } from '@/core/types';

/** Stable JSON: object keys sorted, `undefined` dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => v !== undefined && k !== 'sha256')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 64-bit FNV-1a as 16 hex digits (change detection, not security). */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** `stamps:<16 hex>` over the enabled placements (in order) and their definitions. */
export function stampsFingerprint(cfg: StampsConfig): string {
  const enabled = cfg.instances.filter((i) => i.enabled);
  const used = new Set(enabled.map((i) => i.stampId));
  const definitions = cfg.definitions
    .filter((d) => used.has(d.id))
    .map(({ name: _name, description: _description, ...rest }) => rest);
  return `stamps:${fnv1a64(canonical({ instances: enabled, definitions }))}`;
}
