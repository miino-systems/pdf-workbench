/**
 * Git integration is intentionally limited to *generating commands for the
 * user to run themselves*. This app never shells out to git, never touches
 * credentials, and never performs any remote operation (principle E in
 * ARCHITECTURE.md).
 */

export { DEFAULT_GITIGNORE } from '@/workspace/defaults';

/** Commands to turn a freshly initialised workspace into a git repository. */
export function gitInitCommands(): string[] {
  return ['git init', 'git add .pdf-workbench .gitignore', 'git commit -m "Initialize PDF Workbench"'];
}

/** Commands to commit workspace metadata changes (and push) to an existing repo. */
export function gitUpdateCommands(): string[] {
  return ['git add .pdf-workbench', 'git commit -m "Update PDF workspace"', 'git push'];
}

/**
 * Short, user-facing (Japanese) explanation of what `.gitignore` does and
 * why, shown next to the "copy git commands" UI.
 */
export function explainGitignore(): string {
  return (
    'デフォルトでは papers/（元 PDF）・output/（生成 PDF）・preview/（プレビュー画像）は ' +
    '.gitignore により Git 管理対象外になっています。assets/ や fonts/ もコミットしたい場合は、' +
    '.gitignore 内の該当行のコメント（# assets/ や # fonts/）を外してください。' +
    'このアプリ自体はリモート操作（push/pull/認証など）を一切行いません。' +
    '上記のコマンドをコピーして、ご自身のターミナルで実行してください。'
  );
}
