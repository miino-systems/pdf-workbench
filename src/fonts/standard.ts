/**
 * pdf-lib's built-in "standard 14" fonts (WinAnsi only, no CJK), mapped from
 * the `StandardFontName` type used in `FontRef`.
 */
import { StandardFonts } from 'pdf-lib';
import type { StandardFontName } from '@/core/types';

/** All standard font names selectable via `FontRef.kind === 'standard'`. */
export const STANDARD_FONT_NAMES: readonly StandardFontName[] = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
];

/** `StandardFontName` -> pdf-lib `StandardFonts` enum value. */
export const STANDARD_FONT_MAP: Record<StandardFontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
};

/** Look up the pdf-lib `StandardFonts` value for a `StandardFontName`. */
export function toPdfLibStandardFont(name: StandardFontName): StandardFonts {
  return STANDARD_FONT_MAP[name];
}
