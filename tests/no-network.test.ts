/**
 * Static guarantee for spec §30 / §31: the application source never calls a
 * network API, so PDFs, images, fonts and reports cannot leave the browser.
 * The only network activity is the browser fetching the static bundle
 * itself (and PDF.js' bundled font data from the same origin).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\bfetch\s*\(/, why: 'fetch()' },
  { re: /\bXMLHttpRequest\b/, why: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, why: 'WebSocket' },
  { re: /\bsendBeacon\b/, why: 'navigator.sendBeacon' },
  { re: /\bEventSource\b/, why: 'EventSource' },
  { re: /\bRTCPeerConnection\b/, why: 'WebRTC' },
  { re: /https?:\/\/(?!example\.org)[a-z0-9.-]+\.(com|net|org|io|dev|jp)\//i, why: 'remote URL' },
  { re: /\bgithub\.com\/login\/oauth|api\.github\.com|gitlab\.com\/api/i, why: 'git hosting API' },
  { re: /isomorphic-git/, why: 'git remote transport' },
];

describe('no network access in application code', () => {
  const files = walk(SRC);

  it('scans a meaningful number of source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${path.relative(SRC, file)} does not use network APIs`, () => {
      const text = readFileSync(file, 'utf8')
        // strip comments so documentation may still mention these words
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
      for (const { re, why } of FORBIDDEN) {
        expect(re.test(text), `${why} in ${path.relative(SRC, file)}`).toBe(false);
      }
    });
  }

  it('PDF.js worker is loaded from the bundle, not a CDN', () => {
    const worker = readFileSync(path.join(SRC, 'pdf/reader/worker.ts'), 'utf8');
    expect(worker).toMatch(/import\.meta\.url/);
    expect(worker).not.toMatch(/https?:\/\/[^\s'"]*(cdn|unpkg|jsdelivr)/i);
  });

  it('package.json does not depend on network or git-remote libraries', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies)) {
      expect(dep).not.toMatch(/axios|isomorphic-git|octokit|socket/i);
    }
  });
});
