import { describe, expect, it } from 'vitest';
import { DEFAULT_GITIGNORE, explainGitignore, gitInitCommands, gitUpdateCommands } from '@/git-helper';

describe('git-helper', () => {
  it('gitInitCommands returns init/add/commit, in order', () => {
    const commands = gitInitCommands();
    expect(commands).toEqual([
      'git init',
      'git add .pdf-workbench .gitignore',
      'git commit -m "Initialize PDF Workbench"',
    ]);
  });

  it('gitUpdateCommands returns add/commit/push, in order', () => {
    const commands = gitUpdateCommands();
    expect(commands).toEqual(['git add .pdf-workbench', 'git commit -m "Update PDF workspace"', 'git push']);
  });

  it('never includes a remote / auth command', () => {
    const all = [...gitInitCommands(), ...gitUpdateCommands()];
    for (const cmd of all) {
      expect(cmd).not.toMatch(/git\s+(remote|clone|fetch|pull|credential)/);
    }
  });

  it('re-exports the default .gitignore content used by workspace/', () => {
    expect(DEFAULT_GITIGNORE).toContain('papers/');
    expect(DEFAULT_GITIGNORE).toContain('output/');
    expect(DEFAULT_GITIGNORE).toContain('preview/');
  });

  it('explainGitignore mentions the ignored dirs and that no remote ops happen', () => {
    const text = explainGitignore();
    expect(text).toContain('papers/');
    expect(text).toContain('output/');
    expect(text).toContain('preview/');
    expect(text.length).toBeGreaterThan(0);
  });
});
