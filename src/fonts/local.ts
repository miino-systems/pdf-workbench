/**
 * Local Font Access API (`window.queryLocalFonts()`) integration.
 *
 * This API is not yet in TypeScript's DOM lib, is Chromium-only, and
 * requires a user permission grant, so every access is guarded: importing
 * this module in Node (vitest) must never throw, and denial/unsupported
 * environments must degrade to an empty list rather than throwing.
 */

/** Shape of the browser's `FontData` objects, as far as we use them. */
export interface FontDataLike {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

interface WindowWithLocalFonts {
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontDataLike[]>;
}

/** Font metadata exposed to the rest of the app (no bytes, no `blob()`). */
export interface LocalFontInfo {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

/** postscriptName -> the FontData handle, kept so bytes can be read on demand. */
const fontDataCache = new Map<string, FontDataLike>();

/** Set when the last `listLocalFonts()` call failed (denied / unsupported / errored). */
let lastError: string | undefined;

function getWindowLocalFonts(): WindowWithLocalFonts['queryLocalFonts'] | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as WindowWithLocalFonts).queryLocalFonts;
}

/** Whether `window.queryLocalFonts` exists in this environment. */
export function isLocalFontAccessAvailable(): boolean {
  return typeof getWindowLocalFonts() === 'function';
}

/** The error message from the last failed {@link listLocalFonts} call, if any. */
export function getLastLocalFontsError(): string | undefined {
  return lastError;
}

/**
 * List fonts installed on the user's system via the Local Font Access API.
 * Returns `[]` when the API is unsupported, the user denies the permission
 * prompt, or any other error occurs; call {@link getLastLocalFontsError} to
 * see why.
 */
export async function listLocalFonts(): Promise<LocalFontInfo[]> {
  lastError = undefined;
  const queryLocalFonts = getWindowLocalFonts();
  if (!queryLocalFonts) {
    lastError = 'Local Font Access API is not available in this browser';
    return [];
  }

  try {
    const fonts = await queryLocalFonts();
    fontDataCache.clear();
    const result: LocalFontInfo[] = [];
    for (const font of fonts) {
      fontDataCache.set(font.postscriptName, font);
      result.push({
        family: font.family,
        fullName: font.fullName,
        postscriptName: font.postscriptName,
        style: font.style,
      });
    }
    return result;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

/**
 * Read the raw bytes of a local font by its `postscriptName`.
 *
 * Normally the font was already listed via {@link listLocalFonts} (which
 * populates the cache), but after a page reload `stamps.json` can reference
 * a `local` `FontRef` before the user has re-listed local fonts this
 * session (the permission grant persists across reloads, `queryLocalFonts`
 * results do not get cached anywhere but here). In that case, fall back to
 * a targeted `queryLocalFonts({ postscriptNames: [postscriptName] })` call
 * instead of throwing — this only re-prompts for permission if it was
 * actually revoked, and otherwise resolves silently.
 */
export async function readLocalFontBytes(postscriptName: string): Promise<Uint8Array> {
  let fontData = fontDataCache.get(postscriptName);
  if (!fontData) {
    const queryLocalFonts = getWindowLocalFonts();
    if (!queryLocalFonts) {
      throw new Error(
        `Local font "${postscriptName}" was not found; call listLocalFonts() first to grant access`,
      );
    }
    const found = await queryLocalFonts({ postscriptNames: [postscriptName] }).catch(() => []);
    fontData = found[0];
    if (fontData) fontDataCache.set(postscriptName, fontData);
  }
  if (!fontData) {
    throw new Error(
      `Local font "${postscriptName}" was not found; call listLocalFonts() first to grant access`,
    );
  }
  const blob = await fontData.blob();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
