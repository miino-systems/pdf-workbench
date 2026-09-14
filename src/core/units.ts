/** Unit helpers. Internally everything is in PDF points (1/72 inch). */
export const PT_PER_INCH = 72;
export const MM_PER_INCH = 25.4;
export const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;

export type LengthUnit = 'pt' | 'mm' | 'in';

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}
export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}
export function inToPt(inch: number): number {
  return inch * PT_PER_INCH;
}
export function toPt(value: number, unit: LengthUnit): number {
  switch (unit) {
    case 'pt':
      return value;
    case 'mm':
      return mmToPt(value);
    case 'in':
      return inToPt(value);
  }
}
export function fromPt(pt: number, unit: LengthUnit): number {
  switch (unit) {
    case 'pt':
      return pt;
    case 'mm':
      return ptToMm(pt);
    case 'in':
      return pt / PT_PER_INCH;
  }
}
export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Common paper sizes in points (width x height, portrait). */
export const PAPER_SIZES_PT: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 },
  B5: { width: 498.9, height: 708.66 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};
