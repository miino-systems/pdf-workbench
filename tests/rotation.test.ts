import { describe, expect, it } from 'vitest';
import {
  normalizeAngle,
  toContentPoint,
  toVisiblePoint,
  visiblePageSize,
  type PageAngle,
} from '@/pdf/stamper/rotation';

const ANGLES: PageAngle[] = [0, 90, 180, 270];

describe('normalizeAngle', () => {
  it('maps any multiple of 90 (incl. negative, incl. >360) onto 0/90/180/270', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(270)).toBe(270);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(720)).toBe(0);
  });
});

describe('visiblePageSize', () => {
  it('swaps width/height for 90 and 270, keeps them for 0 and 180', () => {
    const raw = { width: 200, height: 100 };
    expect(visiblePageSize(raw, 0)).toEqual({ width: 200, height: 100 });
    expect(visiblePageSize(raw, 180)).toEqual({ width: 200, height: 100 });
    expect(visiblePageSize(raw, 90)).toEqual({ width: 100, height: 200 });
    expect(visiblePageSize(raw, 270)).toEqual({ width: 100, height: 200 });
  });
});

describe('toContentPoint / toVisiblePoint', () => {
  const raw = { width: 200, height: 100 };

  it('is the identity for angle 0', () => {
    const p = { x: 37, y: 12 };
    expect(toContentPoint(p, 0, raw)).toEqual(p);
    expect(toVisiblePoint(p, 0, raw)).toEqual(p);
  });

  it('are exact inverses of one another for every angle, for random points', () => {
    let seed = 42;
    const rand = (): number => {
      // Deterministic LCG so failures are reproducible without a fixed fixture.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (const angle of ANGLES) {
      for (let i = 0; i < 50; i++) {
        const content = { x: rand() * raw.width, y: rand() * raw.height };
        const visible = toVisiblePoint(content, angle, raw);
        const roundTripped = toContentPoint(visible, angle, raw);
        expect(roundTripped.x).toBeCloseTo(content.x, 9);
        expect(roundTripped.y).toBeCloseTo(content.y, 9);

        // And the other direction.
        const visibleSize = visiblePageSize(raw, angle);
        const visible2 = { x: rand() * visibleSize.width, y: rand() * visibleSize.height };
        const content2 = toContentPoint(visible2, angle, raw);
        const roundTripped2 = toVisiblePoint(content2, angle, raw);
        expect(roundTripped2.x).toBeCloseTo(visible2.x, 9);
        expect(roundTripped2.y).toBeCloseTo(visible2.y, 9);
      }
    }
  });

  /**
   * Regression for a bug where the 90° and 270° branches were swapped:
   * pin down where each corner of the raw (content-space) page ends up in
   * the visible (as-displayed) frame, physically reasoned out (a clockwise
   * `/Rotate 90` turns the content's bottom-left corner to the visible
   * frame's top-left corner) and cross-checked against pdf.js's own
   * `PageViewport` transform.
   */
  it('maps content-space corners to the physically correct visible corner for 90/270', () => {
    // /Rotate 90 (clockwise): content bottom-left -> visible top-left.
    expect(toVisiblePoint({ x: 0, y: 0 }, 90, raw)).toEqual({ x: 0, y: raw.width });
    // content bottom-right (raw.width,0) -> visible bottom-left.
    expect(toVisiblePoint({ x: raw.width, y: 0 }, 90, raw)).toEqual({ x: 0, y: 0 });
    // content top-right (raw.width,raw.height) -> visible bottom-right.
    expect(toVisiblePoint({ x: raw.width, y: raw.height }, 90, raw)).toEqual({
      x: raw.height,
      y: 0,
    });

    // /Rotate 270 (clockwise) === 90 counter-clockwise: content bottom-left -> visible bottom-right.
    expect(toVisiblePoint({ x: 0, y: 0 }, 270, raw)).toEqual({ x: raw.height, y: 0 });
    expect(toVisiblePoint({ x: raw.width, y: 0 }, 270, raw)).toEqual({
      x: raw.height,
      y: raw.width,
    });
  });
});
