/**
 * Let the user pick a single font file from disk, for the `FontRef.kind ===
 * 'file'` case. Prefers the File System Access API's `showOpenFilePicker`
 * when available, otherwise falls back to a hidden `<input type="file">`.
 */

export interface PickedFontFile {
  name: string;
  bytes: Uint8Array;
}

interface FileSystemFileHandleLike {
  getFile(): Promise<File>;
}

interface WindowWithFilePicker {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandleLike[]>;
}

const FONT_ACCEPT = { description: 'Fonts', accept: { 'font/ttf': ['.ttf'], 'font/otf': ['.otf'] } };

/**
 * Prompt the user to pick one `.ttf`/`.otf` file. Rejects if the user
 * cancels the picker (matching both `showOpenFilePicker` and the
 * `<input>` fallback's natural cancel behaviour).
 */
export async function pickFontFile(): Promise<PickedFontFile> {
  const showOpenFilePicker =
    typeof window !== 'undefined'
      ? (window as unknown as WindowWithFilePicker).showOpenFilePicker
      : undefined;

  if (typeof showOpenFilePicker === 'function') {
    const [handle] = await showOpenFilePicker({ multiple: false, types: [FONT_ACCEPT] });
    const file = await handle.getFile();
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  return pickWithHiddenInput();
}

function pickWithHiddenInput(): Promise<PickedFontFile> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('No file picker is available in this environment'));
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf';
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    const cleanup = (): void => {
      input.remove();
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        reject(new Error('No font file was selected'));
        return;
      }
      file
        .arrayBuffer()
        .then((buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }))
        .catch(reject);
    });

    // If the browser supports it, detect a cancelled picker so callers
    // don't hang forever; unsupported browsers simply never resolve until
    // a file is chosen.
    input.addEventListener('cancel', () => {
      cleanup();
      reject(new Error('Font file selection was cancelled'));
    });

    document.body.appendChild(input);
    input.click();
  });
}
