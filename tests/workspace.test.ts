import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { WorkspaceFS } from '@/workspace/fs';
import {
  initializeWorkspace,
  isWorkspaceInitialized,
  loadWorkspace,
  saveStampsConfig,
} from '@/workspace/store';
import { createDefaultPreflightConfig } from '@/workspace/defaults';
import { outputPathFor, isSourcePath, joinPath, dirname, basename, stripExtension } from '@/workspace/paths';
import { createMemoryDirectory, dumpTree } from './helpers/memfs';

function makeFs(): WorkspaceFS {
  return new WorkspaceFS(createMemoryDirectory('my-workspace'));
}

describe('WorkspaceFS basics', () => {
  it('writeText/readText roundtrip and create parent directories', async () => {
    const fs = makeFs();
    await fs.writeText('a/b/c.txt', 'hello');
    expect(await fs.readText('a/b/c.txt')).toBe('hello');
    expect(await fs.exists('a/b')).toBe(true);
  });

  it('writeBytes/readBytes roundtrip', async () => {
    const fs = makeFs();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await fs.writeBytes('data.bin', bytes);
    expect(Array.from(await fs.readBytes('data.bin'))).toEqual([1, 2, 3, 4]);
  });

  it('appendText appends rather than overwrites', async () => {
    const fs = makeFs();
    await fs.appendText('log.jsonl', 'line1\n');
    await fs.appendText('log.jsonl', 'line2\n');
    expect(await fs.readText('log.jsonl')).toBe('line1\nline2\n');
  });

  it('appendText creates the file (and parents) when missing', async () => {
    const fs = makeFs();
    await fs.appendText('history/events.jsonl', 'first\n');
    expect(await fs.readText('history/events.jsonl')).toBe('first\n');
  });

  it('exists() is false for missing paths, true after creation', async () => {
    const fs = makeFs();
    expect(await fs.exists('nope.txt')).toBe(false);
    await fs.writeText('nope.txt', 'x');
    expect(await fs.exists('nope.txt')).toBe(true);
  });

  it('rejects paths containing ..', async () => {
    const fs = makeFs();
    await expect(fs.writeText('../escape.txt', 'x')).rejects.toThrow();
  });

  it('tolerates a leading ./', async () => {
    const fs = makeFs();
    await fs.writeText('./a.txt', 'x');
    expect(await fs.readText('a.txt')).toBe('x');
  });

  it('list() returns [] for a missing directory instead of throwing', async () => {
    const fs = makeFs();
    expect(await fs.list('does/not/exist')).toEqual([]);
  });

  it('list() sorts by name, filters by extension, and skips hidden entries', async () => {
    const fs = makeFs();
    await fs.writeText('papers/b.pdf', 'b');
    await fs.writeText('papers/a.pdf', 'a');
    await fs.writeText('papers/notes.txt', 'n');
    await fs.writeText('papers/.hidden.pdf', 'h');

    const all = await fs.list('papers', { extensions: ['.pdf'] });
    expect(all.map((e) => e.name)).toEqual(['a.pdf', 'b.pdf']);

    const withHidden = await fs.list('papers', { extensions: ['.pdf'], includeHidden: true });
    expect(withHidden.map((e) => e.name)).toEqual(['.hidden.pdf', 'a.pdf', 'b.pdf']);
  });

  it('list() recurses into subdirectories when recursive: true', async () => {
    const fs = makeFs();
    await fs.writeText('papers/a.pdf', 'a');
    await fs.writeText('papers/sub/b.pdf', 'b');

    const flat = await fs.list('papers', { extensions: ['.pdf'] });
    expect(flat.map((e) => e.path)).toEqual(['papers/a.pdf']);

    const recursive = await fs.list('papers', { extensions: ['.pdf'], recursive: true });
    expect(recursive.map((e) => e.path).sort()).toEqual(['papers/a.pdf', 'papers/sub/b.pdf']);
  });
});

describe('workspace/paths', () => {
  it('joinPath / dirname / basename / stripExtension', () => {
    expect(joinPath('a', 'b', 'c.pdf')).toBe('a/b/c.pdf');
    expect(dirname('a/b/c.pdf')).toBe('a/b');
    expect(basename('a/b/c.pdf')).toBe('c.pdf');
    expect(stripExtension('a/b/c.pdf')).toBe('a/b/c');
    expect(dirname('c.pdf')).toBe('');
  });

  it('outputPathFor builds <output dir>/<base><suffix>.pdf', () => {
    const config = createDefaultWorkspaceConfigForTest();
    expect(outputPathFor('papers/report.pdf', config)).toBe('output/report_stamped.pdf');
  });

  it('isSourcePath checks the configured papers/ directory', () => {
    const config = createDefaultWorkspaceConfigForTest();
    expect(isSourcePath('papers/report.pdf', config)).toBe(true);
    expect(isSourcePath('output/report_stamped.pdf', config)).toBe(false);
  });
});

// Local helper avoiding a Date-dependent import of createDefaultWorkspaceConfig directly in every test.
function createDefaultWorkspaceConfigForTest() {
  return {
    version: 1,
    name: 'ws',
    createdAt: new Date().toISOString(),
    directories: { papers: 'papers', output: 'output', preview: 'preview', assets: 'assets', fonts: 'fonts' },
    output: { suffix: '_stamped' },
    history: { hashChain: false },
  };
}

describe('workspace initialisation and (re)loading', () => {
  it('is not initialized before initializeWorkspace() is called', async () => {
    const fs = makeFs();
    expect(await isWorkspaceInitialized(fs)).toBe(false);
  });

  it('initializeWorkspace creates all expected files and directories', async () => {
    const fs = makeFs();
    await initializeWorkspace(fs, { name: 'My Workspace' });

    expect(await isWorkspaceInitialized(fs)).toBe(true);
    for (const dir of ['papers', 'output', 'preview', 'assets', 'fonts']) {
      expect(await fs.exists(dir)).toBe(true);
    }
    expect(await fs.exists(WORKBENCH_FILES.workspace)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.stamps)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.preflight)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.jobs)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.reportsDir)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.snapshotsDir)).toBe(true);
    expect(await fs.exists(WORKBENCH_FILES.events)).toBe(true);
    expect(await fs.readText(WORKBENCH_FILES.events)).toBe('');
    expect(await fs.exists('.gitignore')).toBe(true);

    // Pretty-printed JSON with 2-space indent and trailing newline.
    const raw = await fs.readText(WORKBENCH_FILES.workspace);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "name": "My Workspace"');
    const config = JSON.parse(raw);
    expect(config.name).toBe('My Workspace');
  });

  it('writes the default .gitignore content on a fresh workspace', async () => {
    const fs = makeFs();
    await initializeWorkspace(fs);
    const gitignore = await fs.readText('.gitignore');
    expect(gitignore).toContain('papers/');
    expect(gitignore).toContain('output/');
    expect(gitignore).toContain('preview/');
    expect(gitignore).toContain('# 必要に応じて');
    expect(gitignore).toContain('# assets/');
    expect(gitignore).toContain('# fonts/');
  });

  it('never overwrites an existing .gitignore, but appends missing required lines', async () => {
    const fs = makeFs();
    await fs.writeText('.gitignore', '# my custom rules\nnode_modules/\n');
    await initializeWorkspace(fs);
    const gitignore = await fs.readText('.gitignore');
    expect(gitignore).toContain('# my custom rules');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('papers/');
    expect(gitignore).toContain('output/');
    expect(gitignore).toContain('preview/');
  });

  it('leaves a .gitignore alone if it already has the required lines', async () => {
    const fs = makeFs();
    const custom = 'papers/\noutput/\npreview/\n# already good\n';
    await fs.writeText('.gitignore', custom);
    await initializeWorkspace(fs);
    expect(await fs.readText('.gitignore')).toBe(custom);
  });

  it('loadWorkspace after initializeWorkspace round-trips the same config', async () => {
    const fs = makeFs();
    const initial = await initializeWorkspace(fs, { name: 'Roundtrip' });
    const loaded = await loadWorkspace(fs);
    expect(loaded.config).toEqual(initial.config);
    expect(loaded.stamps).toEqual(initial.stamps);
    expect(loaded.preflight).toEqual(initial.preflight);
    expect(loaded.jobs).toEqual(initial.jobs);
    expect(loaded.warnings).toEqual([]);
  });

  it('re-load restores a modified stamps config', async () => {
    const fs = makeFs();
    const state = await initializeWorkspace(fs);
    const modifiedStamps = {
      ...state.stamps,
      definitions: [{ id: 'd1', name: 'DRAFT', layers: [] }],
    };
    await saveStampsConfig(fs, modifiedStamps);

    const reloaded = await loadWorkspace(fs);
    expect(reloaded.stamps.definitions).toHaveLength(1);
    expect(reloaded.stamps.definitions[0].name).toBe('DRAFT');
  });

  it('loadWorkspace falls back to defaults and warns on missing files', async () => {
    const fs = makeFs();
    const state = await loadWorkspace(fs);
    expect(state.warnings.length).toBeGreaterThan(0);
    expect(state.warnings.some((w) => w.includes('workspace.json'))).toBe(true);
    expect(state.config.directories.papers).toBe('papers');
  });

  it('loadWorkspace falls back to defaults and warns on corrupt JSON', async () => {
    const fs = makeFs();
    await initializeWorkspace(fs);
    await fs.writeText(WORKBENCH_FILES.stamps, '{ not valid json');

    const state = await loadWorkspace(fs);
    expect(state.warnings.some((w) => w.includes(WORKBENCH_FILES.stamps))).toBe(true);
    expect(state.stamps.definitions).toEqual([]);
    expect(state.stamps.instances).toEqual([]);
  });

  it('preflight defaults are A4 portrait, 20/20/18/18mm margins, all checks off', async () => {
    const config = createDefaultPreflightConfig();
    expect(config.id).toBe('default');
    expect(config.page?.size).toBe('A4');
    expect(config.page?.orientation).toBe('portrait');
    expect(config.margins).toEqual({ top: 20, bottom: 20, left: 18, right: 18, unit: 'mm' });
    expect(config.checks).toEqual({ marginText: false, marginRaster: false, stampCollision: false });
  });
});

describe('dumpTree helper sanity check', () => {
  it('reflects writes made through WorkspaceFS', async () => {
    const root = createMemoryDirectory('root');
    const fs = new WorkspaceFS(root);
    await fs.writeText('a/b.txt', 'content');
    const tree = await dumpTree(root);
    expect(tree['a/b.txt']).toBe('content');
  });
});
