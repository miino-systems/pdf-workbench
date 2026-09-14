/**
 * Colour parsing helpers for stamp layers.
 *
 * Stamp layer colours are stored as CSS hex strings (`#rrggbb` or the
 * shorthand `#rgb`) so they round-trip cleanly through JSON. pdf-lib's
 * `rgb()` helper wants each channel as a 0..1 float, which is what
 * {@link parseHexColor} produces.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const HEX6 = /^#([0-9a-fA-F]{6})$/;
const HEX3 = /^#([0-9a-fA-F]{3})$/;

/** Black, used as the fallback for unparsable colours. */
export const FALLBACK_COLOR: RgbColor = { r: 0, g: 0, b: 0 };

/**
 * Parse a `#rrggbb` or `#rgb` hex colour string into 0..1 RGB components.
 * Falls back to black when the input is not a valid hex colour.
 */
export function parseHexColor(value: string): RgbColor {
  const hex6 = HEX6.exec(value);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return {
      r: ((n >> 16) & 0xff) / 255,
      g: ((n >> 8) & 0xff) / 255,
      b: (n & 0xff) / 255,
    };
  }
  const hex3 = HEX3.exec(value);
  if (hex3) {
    const [r, g, b] = hex3[1].split('');
    return {
      r: parseInt(r + r, 16) / 255,
      g: parseInt(g + g, 16) / 255,
      b: parseInt(b + b, 16) / 255,
    };
  }
  return { ...FALLBACK_COLOR };
}

/** True when `value` is a valid `#rrggbb` / `#rgb` hex colour string. */
export function isValidHexColor(value: string): boolean {
  return HEX6.test(value) || HEX3.test(value);
}
