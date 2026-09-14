// Browser smoke test (optional, not part of `npm test`): real Chromium, real
// File System Access API objects (OPFS stands in for the user-picked directory),
// full generate flow. Requires a built dist/ (`npm run build`) and Playwright:
//   PLAYWRIGHT_PKG=/path/to/node_modules/playwright/package.json \
//   CHROMIUM_PATH=/path/to/chrome node e2e/smoke.mjs
// Screenshots are written next to this file.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require('playwright');
const { PDFDocument, PDFName, PDFString, StandardFonts } = createRequire(import.meta.url)('pdf-lib');

const OUT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const BASE = `http://localhost:${PORT}/pdf-workbench/`;

async function buildPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Sample paper page ${i} - https://example.org`, { x: 72, y: 760, size: 14, font });
    if (i === 1) {
      const ref = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [72, 750, 400, 775], Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org') },
      }));
      page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    }
  }
  return doc.save();
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true });
const PDF_BYTES = await buildPdf();
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const requests = [];
const errors = [];
page.on('request', (r) => requests.push(r.url()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => {
  window.showDirectoryPicker = () => navigator.storage.getDirectory();
});

try {
  await page.goto(BASE);
  await page.waitForSelector('text=PDF Workbench');
  const privacy = await page.textContent('.privacy-notice');
  if (!privacy.includes('外部サーバへ送信されません')) throw new Error('privacy notice missing');

  await page.click('button:has-text("ディレクトリを選択")');
  await page.click('button:has-text("新しい Workspace として初期化")');
  await page.waitForSelector('text=Workspace:');

  // Put a PDF into papers/ (OPFS) as the user would with their file manager.
  const pdfB64 = Buffer.from(PDF_BYTES).toString('base64');
  await page.evaluate(async (b64) => {
    const root = await navigator.storage.getDirectory();
    const papers = await root.getDirectoryHandle('papers', { create: true });
    const fh = await papers.getFileHandle('paper001.pdf', { create: true });
    const w = await fh.createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
  }, pdfB64);

  await page.click('button[data-tab="pdf"]');
  await page.click('button:has-text("再読み込み")');
  await page.click('li:has-text("paper001.pdf")');
  await page.waitForSelector('.preview-page canvas', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // Enable DRAFT + page number via the checklist.
  const boxes = page.locator('#section-pdf input[type=checkbox]');
  const n = await boxes.count();
  console.log('stamp checkboxes:', n);
  for (let i = 0; i < n; i++) {
    const label = await boxes.nth(i).locator('xpath=..').textContent();
    if (/DRAFT|Page|ページ/i.test(label)) { await boxes.nth(i).check(); await page.waitForTimeout(300); }
  }
  await page.screenshot({ path: path.join(OUT, 'pdf-tab.png'), fullPage: true });

  await page.click('button:has-text("Generate PDF")');
  await page.waitForSelector('.toast.ok', { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'after-generate.png'), fullPage: true });

  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    async function read(dir, name) { const d = await root.getDirectoryHandle(dir); const f = await (await d.getFileHandle(name)).getFile(); return new Uint8Array(await f.arrayBuffer()); }
    async function sha(b) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
    const src = await read('papers', 'paper001.pdf');
    const out = await read('output', 'paper001_stamped.pdf');
    const wb = await root.getDirectoryHandle('.pdf-workbench');
    const jobs = await (await (await wb.getFileHandle('jobs.json')).getFile()).text();
    const hist = await wb.getDirectoryHandle('history');
    const events = await (await (await hist.getFileHandle('events.jsonl')).getFile()).text();
    return { srcSha: await sha(src), outLen: out.length, outHead: String.fromCharCode(...out.slice(0, 5)), jobs, events };
  });
  const srcSha = await (async () => { const { createHash } = await import('node:crypto'); return createHash('sha256').update(PDF_BYTES).digest('hex'); })();
  console.log('source sha unchanged:', result.srcSha === srcSha);
  console.log('output bytes:', result.outLen, result.outHead);
  console.log('jobs.json:', result.jobs.slice(0, 400));
  console.log('events:', result.events.trim().split('\n').map((l) => JSON.parse(l).type).join(', '));

  // Verify the output loads and keeps the link annotation.
  const outBytes = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('output'); const f = await (await d.getFileHandle('paper001_stamped.pdf')).getFile();
    return Array.from(new Uint8Array(await f.arrayBuffer()));
  });
  const outDoc = await PDFDocument.load(Uint8Array.from(outBytes));
  const annots = outDoc.getPage(0).node.lookup(PDFName.of('Annots'));
  console.log('link annots on page 1:', annots ? annots.size() : 0);

  // Stamps editor: open the DRAFT definition and change its text via the form.
  await page.click('button[data-tab="stamps"]');
  await page.click('#section-stamps li:has-text("DRAFT")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'stamps-editor.png'), fullPage: true });
  const ta = page.locator('#section-stamps textarea').first();
  await ta.fill('DRAFT v2');
  await page.waitForTimeout(800);
  const stampsJson = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const wb = await root.getDirectoryHandle('.pdf-workbench');
    return await (await (await wb.getFileHandle('stamps.json')).getFile()).text();
  });
  console.log('stamps.json contains DRAFT v2:', stampsJson.includes('DRAFT v2'));

  // Preflight run.
  await page.click('button[data-tab="preflight"]');
  await page.click('button:has-text("選択中の PDF を検査")');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'preflight-run.png'), fullPage: true });
  const reports = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const wb = await root.getDirectoryHandle('.pdf-workbench');
    const rep = await wb.getDirectoryHandle('reports');
    const names = []; for await (const [n] of rep.entries()) names.push(n); return names;
  });
  console.log('reports:', reports);

  // Other tabs render without errors.
  for (const t of ['sequence', 'history', 'settings', 'workspace']) {
    await page.click(`button[data-tab="${t}"]`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${t}.png`), fullPage: true });
  }

  const external = requests.filter((u) => !u.startsWith(`http://localhost:${PORT}/`));
  console.log('requests:', requests.length, 'external:', external);
  console.log('errors:', errors);
  if (external.length || errors.length) process.exitCode = 1;
} catch (e) {
  console.error('E2E FAILED', e);
  await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  process.exit(process.exitCode ?? 0);
}
