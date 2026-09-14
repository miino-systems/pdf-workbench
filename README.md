# PDF Workbench

ブラウザ上で動作する **ローカル完結型** の PDF Workbench です。
既存 PDF に複数のスタンプ（学会ロゴ・CC ライセンス・ページ番号・DRAFT など）を付与し、
元 PDF のハイパーリンク等を維持したまま **別ファイルとして** 保存します。

これは「PDF をサーバへアップロードして加工する Web サービス」ではなく、
**ブラウザを UI として利用するローカル PDF 処理アプリケーション** です。
データの主体は常にユーザーのローカル Workspace であり、Web App はその Workspace を
読み書きする UI と処理エンジンに徹します。

> **PDF・画像・フォントはブラウザ内で処理され、外部サーバへ送信されません。**

## 目的

- 既存 PDF への複数スタンプ付与（text / image / page number）
- 元 PDF を **絶対に上書きしない**（`papers/` は immutable source、出力は `output/`）
- 既存 hyperlink annotation の維持（pdf-lib で既存ページに追記し、ページを描画し直さない）
- 作業状態・操作履歴の Workspace 内保存（append-only journal + snapshot）
- 将来拡張: preflight チェック、PDF → PNG/JPEG 変換、raster margin check、hash-chain audit log

## Privacy model

| 項目 | 方針 |
|------|------|
| PDF / PNG / JPEG / フォント / preview / report | ブラウザ内でのみ処理。**ネットワーク送信しない** |
| ライブラリ (pdf-lib, PDF.js, fontkit) | ビルド成果物に bundle。CDN 不使用 |
| ネットワーク通信 | アプリ本体 (静的ファイル) の取得のみ。バックエンド API なし |
| 設定・作業状態 | Workspace 内 `.pdf-workbench/*.json` が正本 |
| localStorage | テーマ・タブ・パネル開閉・既定 DPI 等の UI preference のみ |
| IndexedDB | 最近使った `FileSystemDirectoryHandle`（Workspace 再オープン用）のみ |
| Git | ユーザー自身がローカル端末のターミナルで操作。アプリは **コマンドを生成・コピーするだけ** |

アプリは GitHub OAuth / GitHub API / git push / PAT 保存 / SSH などの remote 操作を一切実装しません。

## Browser requirement

第一対象は Desktop Chromium 系（**Chrome / Edge**）です。

| 機能 | 依存 API | Chrome / Edge | Firefox / Safari |
|------|----------|---------------|------------------|
| Workspace（ローカルディレクトリ読み書き） | File System Access API | ✓ | ✗（案内を表示） |
| ローカルフォント一覧 | Local Font Access API (`queryLocalFonts`) | ✓ | ✗（Workspace フォント / ファイル選択に fallback） |
| PDF preview / stamp / hash | PDF.js / pdf-lib / Web Crypto | ✓ | ✓ |

非対応ブラウザでは「このブラウザではローカルディレクトリ機能が利用できません」と表示し、
利用できる機能のみ提供します。

## Workspace structure

ユーザーが選択したローカルディレクトリを Workspace として扱います。

```
workspace/
├─ papers/              元 PDF（immutable。アプリは読み取りのみ）
├─ output/              生成 PDF（例: paper001_stamped.pdf）
├─ preview/             PNG / JPEG
├─ assets/              スタンプ画像（例: nolta-logo.png, cc-by.png）
├─ fonts/               Workspace フォント（.ttf / .otf）
│
├─ .pdf-workbench/
│   ├─ workspace.json   Workspace 設定
│   ├─ stamps.json      StampDefinition / StampInstance
│   ├─ preflight.json   preflight ルール
│   ├─ jobs.json        処理ジョブ（source の SHA-256、output パス、通しページ範囲）
│   ├─ sequence.json    通しページ番号の順序（並び順・先頭番号・ファイル別の固定/除外）
│   ├─ reports/         preflight レポート (JSON)
│   └─ history/
│       ├─ events.jsonl 操作履歴（append-only, JSON Lines）
│       └─ snapshots/   設定 snapshot（YYYYMMDDTHHMMSS.json）
│
└─ .gitignore
```

`.pdf-workbench/` が無いディレクトリを選択すると「新しい Workspace として初期化」できます。
画像・フォントの本体は JSON に埋め込まず、Workspace 内の相対パスで参照します。

## Git は optional

Git を使わなくても全機能が動作します。Git 管理する場合の推奨対象は

```
.pdf-workbench/**
.gitignore
```

のみで、PDF・画像・生成物は Git に含めないことを推奨します（既定の `.gitignore` が
`papers/ output/ preview/` を除外します。`assets/ fonts/` を管理したい場合はコメントを外してください）。

アプリの「Git」パネルは次のようなコマンドを表示し、コピーボタンを提供します。

```
git init
git add .pdf-workbench .gitignore
git commit -m "Initialize PDF Workbench"
```

```
git add .pdf-workbench
git commit -m "Update PDF workspace"
git push
```

**Git remote はアプリから操作しません。** remote の設定・認証はユーザー自身の責任で行ってください。

## 使い方（Phase 1）

1. Chrome / Edge で開き、**Workspace** タブで「ディレクトリを選択」
2. `.pdf-workbench/` が無ければ「初期化」
3. `papers/` に PDF を置き、**PDF** タブでファイルを選択して preview
4. **Stamps** タブでスタンプ定義（テンプレートから追加可）と適用ページ・位置を設定
5. **PDF** タブで適用するスタンプにチェックを入れ **Generate PDF** → `output/<name>_stamped.pdf`
6. 操作は `.pdf-workbench/history/events.jsonl` に記録され、source の SHA-256 は `jobs.json` に保存されます。
   前回処理後に元 PDF が変更されると「⚠ 元 PDF が前回処理時から変更されています」と警告します。

### 通しページ番号（Sequence タブ）

複数の PDF（予稿集の各論文など）に **通し番号** を振るための仕組みです。
`papers/` の PDF を並べた順にページ番号を割り当て、pageNumber スタンプの `{page}` は
その番号（`page_start + 物理ページ − 1`）になります。設定は `.pdf-workbench/sequence.json` に保存されます。

| 設定 | 意味 |
|------|------|
| 並び順 `order` | `name`: ファイル名の自然順（`paper2 < paper10`）。`manual`: 一覧の順（▲▼で並べ替え。未登録のファイルは名前順で末尾に追加） |
| 最初のページ番号 `firstPage` | 先頭ファイルの 1 ページ目の番号（既定 1） |
| 各ファイルの開始ページ `startOn` | `any` / `odd`（各論文を奇数＝右ページから始める。必要なら番号を 1 つ飛ばす） / `even` |
| 開始番号（ファイル別） `startPage` | そのファイルの開始番号を固定。以降のファイルはそこから連番（飛び番・再開・外部で番号付けした資料の分を空ける用途） |
| 除外（ファイル別） `skip` | 通し番号から外す。そのファイルのスタンプはスタンプ側の `startAt` を使う |

```json
{
  "version": 1,
  "order": "manual",
  "firstPage": 1,
  "startOn": "odd",
  "entries": [
    { "file": "papers/front-matter.pdf", "skip": true },
    { "file": "papers/paper001.pdf" },
    { "file": "papers/paper002.pdf", "startPage": 21 }
  ]
}
```

- 各ファイルの `page_start–page_end` は Sequence タブと PDF タブのファイル一覧に表示されます。
- 「CSV / JSON を output/ に書き出す」で `output/page-ranges.csv`（`filename,page_start,page_end,page_count`）と
  `output/page-ranges.json`（同じ行 + `path` / `output` / `skipped`）を出力します。目次や索引の生成に使えます。
- 生成済みの PDF は、その後に順序が変わって開始番号がずれると「⚠ Page numbers changed」と表示されます（再生成してください）。
- ページ数を読めない PDF があると、その位置から後ろの番号は確定しません（`startPage` で再開できます）。誤った番号を振るより安全側に倒しています。

## テスト

```
npm test           # vitest: 元 PDF の SHA-256 不変, 別ファイル出力, hyperlink 維持, 日本語フォント embed,
                   #         複数スタンプ, 通しページ番号 (sequence.json) と page-ranges 書き出し,
                   #         Workspace 再オープンでの設定復元, events.jsonl, ネットワーク API 不使用
node e2e/smoke.mjs # optional: Chromium で Workspace 初期化 → preview → Generate → preflight を通しで確認
```

`e2e/smoke.mjs` は Playwright と Chromium が必要です（`PLAYWRIGHT_PKG` / `CHROMIUM_PATH` を指定）。
Workspace には OPFS (`navigator.storage.getDirectory()`) を使い，外部リクエストが 0 件であることも検査します。

## Development

```
npm install
npm run dev        # http://localhost:5173/pdf-workbench/
npm test           # vitest (pdf-lib / PDF.js in Node)
npm run typecheck
npm run build      # dist/
```

設計の詳細は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## GitHub Pages deployment

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main` に push すると `.github/workflows/deploy.yml` がテスト・ビルドし、`dist/` を Pages に公開する
3. 公開 URL は `https://<user>.github.io/<repo>/`。`vite.config.ts` の `base` は
   workflow から `VITE_BASE=/<repo>/` で渡される（ルート配信する場合は `VITE_BASE=/`）

手動で任意の HTTPS static server に置く場合:

```
VITE_BASE=/ npm run build
# dist/ の中身をそのままアップロード（バックエンド不要）
```

File System Access API は **secure context (HTTPS または localhost)** でのみ動作します。

## License

MIT
