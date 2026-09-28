# `.pdf-workbench/*.json` フォーマット

Workspace の設定ファイルは手で編集してもよい、素の JSON です。各ファイルの
JSON Schema (draft 2020-12) は `public/schemas/` に置かれており、アプリが
書き込むファイルは 1 行目に `$schema` を含みます。エディタ（VS Code など）で
開くと、そのスキーマにもとづいて補完・検証が効きます。

```
public/schemas/
├─ workspace.schema.json   https://miino-systems.github.io/pdf-workbench/schemas/workspace.schema.json
├─ stamps.schema.json      https://miino-systems.github.io/pdf-workbench/schemas/stamps.schema.json
├─ preflight.schema.json   https://miino-systems.github.io/pdf-workbench/schemas/preflight.schema.json
├─ sequence.schema.json    https://miino-systems.github.io/pdf-workbench/schemas/sequence.schema.json
└─ jobs.schema.json        https://miino-systems.github.io/pdf-workbench/schemas/jobs.schema.json
```

`$schema` はエディタ支援のためだけの情報で、アプリは読み込み時にこのキーを
無視します（読み込んだ後、インメモリの設定オブジェクトから取り除かれます）。
保存するたびにアプリが 1 行目として書き直すので、手で書き換えても消えても
実害はありません。

以降で長さの単位を明記していない値は、すべて **pt**（PDF ポイント。
1 mm ≈ 2.835 pt、1/72 inch）です。座標系は PDF 標準どおり、原点は
ページ左下、x は右方向、y は上方向が正です。

すべてのファイルで、アプリが認識しないキーは読み込み時に無視されます
（`additionalProperties` を厳しく制限していないのはこのためで、将来の
フィールド追加や外部ツールとの共存を優先しています）。

## 変更の検知・上書きについて

このアプリは `.pdf-workbench/*.json` を外部エディタや Git などで書き換える
ことを前提にしています。

- アプリを開いたまま外部で書き換えても、その変更が消えることはありません。
  アプリは各ファイルを最後に読み書きした時点の内容を覚えていて、
  - ウィンドウに戻ったとき（フォーカス）と、表示中は 4 秒ごとに、外部で
    変更されたファイルを読み直します（「Workbench の外で変更された ○○ を
    読み込みました」と通知）。
  - 保存の直前にも同じ確認をし、外部で変更されていれば、まずその内容を
    読み込んでから今回の変更だけを適用します（例: 外で文字サイズを変更 →
    Workbench でドラッグ → 文字サイズはそのまま、位置だけ更新）。
  - 同じスタンプのデザインが外部と Workbench の両方で変更された場合や、
    Settings / Preflight のフォームを保存しようとした場合は、外部の内容を
    優先し、Workbench 側の変更は保存せずに警告します。
  - 外部の内容が JSON として壊れている場合は、直るまで一切上書きしません。
  - 外部の変更を読み込むと、それ以前の Undo 履歴は破棄されます（古い状態に
    戻して外部の変更を消さないため）。
- ヘッダの **更新**（または <kbd>⌘R</kbd> / <kbd>Ctrl+R</kbd>）で Workspace 全体
  （PDF の一覧を含む）を読み直すこともできます。
- 読み込み時、JSON として壊れているファイルは **上書きされず**、警告を出した
  うえで（そのファイルだけ）既定値をメモリ上で使って動作を続けます。次に
  アプリがそのファイルへ保存するまで、ディスク上の壊れた内容はそのまま
  残ります。
- `sequence.json` は特に「手書き・スクリプト生成」を許容する設計で、
  キーが足りない・型が違う・壊れた `entries` があっても、認識できる部分だけを
  使い、残りは既定値に落として読み込みます（`normalizeSequenceConfig`）。

---

## workspace.json

Workspace 全体の設定です。

```json
{
  "$schema": "https://miino-systems.github.io/pdf-workbench/schemas/workspace.schema.json",
  "version": 1,
  "name": "NOLTA2026 予稿集",
  "createdAt": "2026-01-10T02:00:00.000Z",
  "directories": {
    "papers": "papers",
    "output": "output",
    "preview": "preview",
    "assets": "assets",
    "fonts": "fonts",
    "preflight": "preflight"
  },
  "output": { "suffix": "_stamped" },
  "history": { "hashChain": false }
}
```

- `directories.papers` は読み取り専用として扱われる元 PDF のディレクトリで、
  アプリは絶対に上書きしません。
- `directories.preflight`（省略時 `preflight`）は、Preflight タブの一括検査で
  問題のあった PDF の注釈付きコピーと
  `summary.csv` / `summary.json` を保存するディレクトリです。注釈付きコピーの
  名前は出力ファイル名（`<元ファイル名><suffix>.pdf`，または `sequence.json` の
  `entries[].output`）の `.pdf` の前に `_preflight` を付けたものです
  （例: `paper001_stamped_preflight.pdf`，`NOLTA2026-A1-01_preflight.pdf`）．一括検査の
  たびに中身はいったん全て削除されます（途中で中止した場合は、検査済みの
  分だけが残り、`summary.json` に `"cancelled": true` が入ります）。
- PDF タブの「すべて作り直す」をオンにした全ファイル処理では、`output/` の
  中身を全て削除し、`jobs.json` の記録も消してから生成します。
- `output.suffix` は既定の出力ファイル名（`<元ファイル名><suffix>.pdf`）に使う
  接尾辞です。`sequence.json` の `entries[].output` で個別に上書きできます。
- `history.hashChain` を `true` にすると、`history/events.jsonl` に追記する
  各イベントに `prevHash`/`hash` のハッシュチェーンを付与します。

---

## stamps.json

スタンプの雛形（`definitions`）と、実際に PDF へ適用する設定
（`instances`）です。

```json
{
  "$schema": "https://miino-systems.github.io/pdf-workbench/schemas/stamps.schema.json",
  "version": 1,
  "definitions": [
    {
      "id": "cc-by-4.0",
      "name": "CC BY 4.0",
      "layers": [
        { "id": "logo", "type": "image", "src": "assets/cc-by.png", "width": 40 },
        {
          "id": "label",
          "type": "text",
          "text": "CC BY 4.0",
          "font": { "kind": "standard", "name": "Helvetica" },
          "size": 10,
          "color": "#000000"
        }
      ],
      "layout": { "direction": "row", "gap": 6, "align": "center" },
      "defaultPosition": { "anchor": "bottom-right", "offsetX": 36, "offsetY": 24 },
      "defaultPages": { "kind": "all" }
    }
  ],
  "instances": [
    {
      "id": "inst-1",
      "stampId": "cc-by-4.0",
      "enabled": true,
      "pages": { "kind": "first" }
    }
  ]
}
```

### 位置 (`position` / `defaultPosition`)

```ts
{ anchor: StampAnchor; offsetX: number; offsetY: number }  // pt
```

`anchor` は `top-left` … `bottom-right` の 9 通り（縦位置-横位置）。
`offsetX`/`offsetY` は、**anchor の辺からスタンプの箱（bounding box、後述）の
対応する辺までの、内向きの距離**です。

- 右系の anchor（`*-right`）: `offsetX` は「ページの右端」から「箱の右端」まで
  の距離。
- 左系の anchor（`*-left`）: `offsetX` は「ページの左端」から「箱の左端」まで
  の距離。
- `*-center`: `offsetX` は箱の中心をページ中心から右方向にずらす量。
- 上系の anchor（`top-*`）: `offsetY` は「ページの上端」から「箱の上端」までの
  距離。
- 下系の anchor（`bottom-*`）: `offsetY` は「ページの下端」から「箱の下端」ま
  での距離。
- `middle-*`: `offsetY` は箱の中心をページ中心から上方向にずらす量。

`instances[].position` を設定すると、その定義の `defaultPosition` を
インスタンス単位で上書きします。PDF プレビューでスタンプをドラッグすると、
このインスタンス側の `position` に自動的に書き込まれます（Stamps タブでは
「独自の位置」（ピンのアイコン）と表示され、「既定位置に戻す」ボタンでこのキーを削除して
`defaultPosition` に戻せます）。

### テキストの箱とベースライン

`text` / `pageNumber` レイヤーの箱（bounding box）は次のように決まります。

- **幅**: 実フォントメトリクスで測った、最も長い行の幅。
- **高さ**:
  - 1 行のときはそのフォントの `size` におけるアセント〜ディセントの高さ
    （pdf-lib の `heightAtSize`）。
  - 2 行以上のときは `行数 × lineHeight × size`。
- **1 行目のベースライン**は、箱の**上端から `0.8 × size` 下**の位置に置か
  れます（アセントを 0.8em、ディセントを 0.2em とみなす近似）。

したがって、たとえば top 系の anchor で `offsetY` を指定した場合：

```
baseline = ページ上端 − offsetY − 0.8 × size
```

つまり **`offsetY` はベースラインの位置ではなく、文字の上端（おおよそ
キャップハイト/アセントの上端）までの距離**です。bottom 系の anchor では
`offsetY` は箱の下端（おおよそディセントの下端）までの距離になり、実際の
ベースラインはフォントによって `offsetY` よりわずかに上に来ます。

### 改行・複数行・揃え

- `text`（および `pageNumber` の `template` を展開した結果）に含まれる
  `\n` は改行になります。
- `lineHeight`（`TextLayer`/`PageNumberLayer` 共通、既定 `1.2`）は、
  ベースラインからベースラインまでの距離を `size` に対する倍率で指定します。
- `align`（既定 `left`）は、複数行になったときの**ブロック内での行の水平
  揃え**です。ブロック自体の幅は最も長い行の幅で決まり、ブロックの位置は
  `anchor`/`offsetX`/`offsetY` で決まります。`align` はその中で個々の行を
  左・中央・右のどこに揃えるかだけを指定します。

### レイヤーの配置（`dx`/`dy` と `layout`）

各レイヤーは `dx`/`dy`（pt）を持てます。これは**スタンプの原点**（`layout`
未設定時は箱の左下）からの追加オフセットです。

- `layout` を設定しない場合、すべてのレイヤーは同じ原点に重なり、`dx`/`dy`
  の分だけずれます。スタンプ全体の箱は各レイヤーの箱の**和集合
  (union)** になります。
- `StampDefinition.layout` を設定すると、`layers` 配列の順に自動で並べます。
  - `direction: "row"`: 左→右に並べる。
  - `direction: "column"`: 上→下に並べる。
  - `align`（既定 `center`）: 並べる方向と直交する軸での揃え。`row` では
    `start` = 上揃え・`end` = 下揃え、`column` では `start` = 左揃え・
    `end` = 右揃え。
  - `gap`: 隣り合うレイヤー間の間隔（pt）。
  - この自動配置のあとで、各レイヤー自身の `dx`/`dy` がさらに補正として
    加算されます。

  例: ロゴ画像の右にヘッダーテキストを並べる場合。

  ```json
  {
    "layers": [
      { "id": "logo", "type": "image", "src": "assets/logo.png", "width": 32 },
      { "id": "header", "type": "text", "text": "Confidential", "font": { "kind": "standard", "name": "Helvetica-Bold" }, "size": 12, "color": "#000000" }
    ],
    "layout": { "direction": "row", "gap": 6, "align": "center" }
  }
  ```

### 画像レイヤー

- `src` は Workspace 相対パス（`assets/…`）。PNG または JPEG。
- `width` だけ、または `height` だけを指定すると、元画像のアスペクト比を
  保ったまま拡大縮小します。
- 両方を指定すると比率を無視して引き伸ばされ、元画像のアスペクト比と
  2% 以上異なる場合はアプリが警告を出します。
- 両方省略すると、元画像のピクセル数をそのまま pt として使います
  （1 px = 1 pt）。

### `pages` (PageSelector)

`instances[].pages` / `definitions[].defaultPages` は次のいずれかです。

| `kind` | 意味 |
|---|---|
| `all` | 全ページ |
| `first` | 先頭ページのみ |
| `last` | 最終ページのみ |
| `odd` | 奇数ページ |
| `even` | 偶数ページ |
| `range` | `{ "from": number, "to": number }`（逆順でもよい） |
| `list` | `{ "pages": number[] }`（個別指定） |

---

## preflight.json

出力前チェックのルールです。

```json
{
  "$schema": "https://miino-systems.github.io/pdf-workbench/schemas/preflight.schema.json",
  "version": 1,
  "id": "proceedings",
  "name": "予稿集",
  "page": { "size": "A4", "orientation": "portrait", "tolerance": 2 },
  "margins": { "top": 20, "bottom": 20, "left": 18, "right": 18, "unit": "mm",
               "tolerance": { "top": 2, "bottom": 2, "left": 2, "right": 0.5 } },
  "marginOverrides": [
    { "pages": { "kind": "first" }, "margins": { "top": 35 } }
  ],
  "pages": { "min": 1, "max": 6 },
  "textRules": [
    { "id": "orcid", "pages": { "kind": "first" }, "require": "ORCID\\s*iDs?", "message": "ORCID 欄がありません" },
    { "id": "orcid-id", "pages": { "kind": "first" }, "require": "\\d{4}-\\d{4}-\\d{4}-\\d{3}[\\dX]", "message": "ORCID iD が見当たりません" },
    { "id": "page-number", "forbid": "^\\d{1,3}$|Page \\d+ of \\d+", "flags": "i", "severity": "error", "message": "原稿にページ番号を入れないでください" }
  ],
  "checks": { "marginText": true, "marginRaster": false, "stampCollision": true, "stampDuplicate": true,
              "textOverlap": true, "fonts": true }
}
```

- `page.tolerance` は**用紙サイズの判定だけ**に使う許容誤差（pt）です。
- `margins.tolerance`（pt、既定 2）は余白の許容誤差です。余白の線からこの
  距離までのはみ出しは違反にしません。数値 1 つなら上下左右共通、
  `{ "top", "bottom", "left", "right" }` のオブジェクトなら辺ごとに指定でき
  ます（省略した辺は 2）。両端揃えの行の右端や最終行の
  ベースラインが線にちょうど接している場合の誤検出を防ぎます。
- 文字は**ベースライン**で判定します（下余白では、最終行のベースラインが
  線より下に出たら違反）。描画ベースのチェック（`marginRaster`）は、文字
  ベースのチェックも有効なとき、そちらで判定した行（ディセンダを含む）を数えず、図・罫線・
  画像など文字以外のはみ出しを見ます。
- **見えない要素（phantom）**: ページを画像化して検査するとき（UI からの
  検査。`marginText` が有効なら `marginRaster` が無効でも画像化します）、
  余白にはみ出した文字の範囲に何も描かれていなければ（不可視・白の文字
  など、テンプレートの残骸）、その文字は**結果に数えません**。
  `marginRaster` で見つけた余白の描画も、いちばん濃い画素が輝度 240 以上
  （ほぼ白）なら同じ扱いです。レポートの finding には `"phantom": true` が
  付き、注釈付きコピーには灰色の枠と「（参考）」のコメントで残ります。
  そのため、結果が「問題なし」でも見えない要素がある PDF は注釈付き
  コピーが作られます。
- 一括検査の注釈付きコピーでは、同じ余白に接する連続した行を 1 つの赤枠に
  まとめ、コメントに「… ほか N 行」と書きます。
- `marginOverrides` は特定ページだけ `margins` の一部を上書きします。
  上の例では、先頭ページ（`{"kind":"first"}`）だけ上余白を 35mm にし、
  下・左・右は base の `margins`（20/20/18/18mm）のままです。
  **指定した辺だけが上書き**され、単位は上書き先の `margins.unit` に従い
  ます。複数の override が同じページに当てはまる場合は、配列の**後の
  要素ほど優先**（辺ごとに）されます。
  この上書きは余白チェック（`marginText` / `marginRaster`）と、一括検査の
  注釈付きコピーに描く枠の両方に使われます。
- `textRules` は、指定したページに**必ずある**（`require`）／**あっては
  ならない**（`forbid`）テキストを正規表現で書くルールです（`checks` の
  スイッチはなく、書いてあれば常に実行）。会議・論文誌ごとの決まり
  （ORCID 欄、キーワード欄、手書きのページ番号の禁止など）を設定だけで
  足せます。Preflight タブの「テキストルール」でも編集できます。
  - 照合するテキストは、各ページの文字列を、改行や連続した空白を空白 1 つ
    にしてつないだものです（同じ行でくっついた文字片はそのままつなぎます）。
    行末のハイフネーションは残ります。ページをまたいだ一致はしません。
  - パターンは JavaScript の正規表現で、`u` フラグが常に付きます。
    `flags` で `i`（大文字小文字を無視）などを足せます。JSON の中では
    `\` を `\\` と書きます（例: `"ORCID\\s*iDs?"`）。
  - `require`: `pages`（省略時は全ページ）のどのページにも一致しなければ、
    その最初のページに `TEXT_REQUIRED:<id>` を報告します（場所がないので
    注釈付きコピーでは付箋だけ）。
  - `forbid`: 一致した箇所ごとに `TEXT_FORBIDDEN:<id>` を報告し、注釈付き
    コピーで赤枠にします。
  - 1 つのルールに `require` と `forbid` の両方を書くこともできます。
  - `severity` は既定 `warning`。`error` にすると結果がエラーになります。
  - `message` は注釈付きコピーのコメントと結果一覧に出る説明です。
  - 正規表現が正しくないルールは実行されず、文書レベルの警告
    `TEXT_RULE_INVALID:<id>` になります。
- `skipFiles` は一括検査で**スルー**する PDF の Workspace 内パス
  （例: `"papers/9002.pdf"`）の一覧です。誤検出が分かっている PDF を
  指定します。PDF タブでファイルを選び「検査スルー」をオンにすると
  追加されます。スルーした PDF は検査されず、`summary.csv` に `skipped`
  として載り、注釈付きコピーは作られません（「1 件だけ検査」では検査
  できますが、summary と注釈付きコピーは更新しません）。
- `checks`:
  - `marginText`: PDF のテキストオブジェクト座標に基づく余白チェック。
  - `marginRaster`: ラスタライズした画像に基づく余白チェック
    （テキスト以外の描画も検出）。
  - `stampCollision`: スタンプが既存の描画と重ならないかのラスタベースの
    チェック。
  - `stampDuplicate`: 有効なスタンプと同じ内容が原稿にすでに入っていないか
    （`STAMP_DUPLICATE`）。著者が自分でライセンス表記やロゴを入れていて、
    スタンプを押すと二重になる場合を見つけます。スタンプを適用するページ
    だけを調べ、見つかった場所を注釈付きコピーで赤枠にします。
    - テキストレイヤー: 空白・改行・ハイフン（行末のハイフネーション）を
      無視した完全一致（複数行なら 20 文字以上の各行も単独で）に加え、
      5 語以上のテキストは、原稿の連続した部分にその**語の 8 割以上**が
      あれば重複とみなします（大文字小文字・句読点は無視）。年の違いや
      「Non-Commercial」と「Non Commercial」のような差があっても見つかります。
      ページ番号レイヤーは対象外です。
    - 画像レイヤー: 原稿に埋め込まれた画像を 16×16 に縮小した濃淡の
      パターンと縦横比で比べるので、大きさや解像度・圧縮が違っても同じ絵
      なら見つかります。ベクター（線や文字）で描かれたロゴは画像ではない
      ため対象外で、同じ図柄でも版が違う（例: CC BY と CC BY-NC-ND）もの
      は別物と判定されます。
  - `textOverlap`: 別々の文字列が重なって描かれている箇所（`TEXT_OVERLAP`）。
    ロゴが描けずに文字（例: `orcid`）に化けて隣の文字に重なった、といった
    表示崩れの兆候を見つけ、注釈付きコピーで重なった側の文字列を赤枠に
    します。数式の添字・アクセント・演算子のような 1 文字だけの文字列、
    隣の行と接するだけのもの、字詰めによるわずかな重なり、同じ文字列を
    ほぼ同じ位置に重ねた疑似ボールドは対象外です（縦に 6 割以上、横に
    狭い方の幅の 3 割かつ 2pt 以上重なったものだけを報告）。
  - `fonts`: 埋め込まれていないフォント（`FONT_NOT_EMBEDDED`。閲覧環境の
    フォントで代用されるので見た目が変わる・文字が化ける原因になります。
    Helvetica や Times などの標準 14 フォントも含みます）と、Type 3 フォント
    （`FONT_TYPE3`。古い TeX 環境のビットマップフォントなど）を、フォント
    ごとに最初に使われたページで 1 回だけ報告します（場所がないので注釈付き
    コピーでは付箋にフォント名が出ます）。
  - 新規作成した Workspace の既定値（`createDefaultPreflightConfig()`）
    はすべて `true` です（以前に作った Workspace の preflight.json は
    そのまま）。

---

## sequence.json

複数の PDF をまたぐ**通しページ番号**のための、ファイルの並び順と個別設定
です。

```json
{
  "$schema": "https://miino-systems.github.io/pdf-workbench/schemas/sequence.schema.json",
  "version": 1,
  "order": "manual",
  "firstPage": 1,
  "startOn": "odd",
  "entries": [
    { "file": "papers/front-matter.pdf", "skip": true },
    { "file": "papers/paper001.pdf", "output": "NOLTA2026-A1-01.pdf" },
    { "file": "papers/paper002.pdf", "output": "NOLTA2026-A1-02.pdf", "startPage": 41 }
  ]
}
```

- `order`:
  - `"name"`: ファイル名の自然順（`paper2.pdf` < `paper10.pdf`）。`entries`
    は各ファイルの `startPage`/`skip`/`output` の個別設定だけを持たせます。
  - `"manual"`: `entries` の並び順どおり。`entries` に載っていないファイル
    は、名前順で末尾に自動的に追加されます（通し番号から漏れることはあり
    ません）。
- `firstPage`: 先頭ファイルの最初のページに振る番号（既定 1）。
- `startOn`:
  - `"any"`: 各ファイルは直前のファイルの続きのページ番号から始まる。
  - `"odd"`: 各ファイルを奇数ページ（レクト）始まりにする。必要なら 1
    ページ分の欠番を作って調整します。`startPage` を明示したファイルには
    このルールは適用されません。
  - `"even"`: 同様に偶数ページ始まり。
- `entries[].startPage`: このファイルの最初のページ番号を固定します。
  以降のファイルはこの番号から続けて通し番号が振られます（欠番・再ス
  タート・外部ですでに採番済みの資料などに使います）。
- `entries[].skip`: `true` にすると、このファイルを通しページ番号の対象
  から除外します（そのファイルのページ番号スタンプは
  `PageNumberLayer.startAt` にフォールバックします）。
- `entries[].output`: 出力ディレクトリ内でのファイル名（既定の
  `<元ファイル名><suffix>.pdf` を上書き）。`.pdf` は省略すると自動付与さ
  れ、サブディレクトリは指定できますが `..` は使えません。
- `origin`（任意）: この並び順がどこから来たかを記録するための、純粋に
  参考情報のフィールドです。`{"kind":"import"|"manual"|"name", "source"?,
  "format"?: "csv"|"json", "importedAt"?, "editedAt"?, "sortKey"?, "rows"?}`
  という形をとります。**アプリ自身はこのフィールドを書き込みません**
  （CSV/JSON の取り込み時にも設定されません）。手動編集や外部スクリプト
  が書いた場合、形が正しければそのまま保持され、それ以外は黙って無視さ
  れます（エラーにはなりません）。

`sequence.json` は手書き・スクリプト生成の両方を想定しているため、キーが
足りない・型が違う場合は警告を出しつつ既定値やベストエフォートの解釈で
読み込みます。たとえば `entries` が文字列の配列（ファイル名だけの配列）
でもよく、その場合は `order` が自動的に `"manual"` になります。

---

## jobs.json

アプリが PDF を生成するたびに追記する処理履歴です。**手で編集することは
想定していません**（アプリ自身が読み書きします）。

```json
{
  "$schema": "https://miino-systems.github.io/pdf-workbench/schemas/jobs.schema.json",
  "version": 1,
  "jobs": [
    {
      "id": "job-1",
      "source": "papers/paper001.pdf",
      "sourceHash": "sha256:9f86d0818184...",
      "output": "output/NOLTA2026-A1-01.pdf",
      "outputHash": "sha256:3a7bd3e2360a...",
      "stampInstances": ["inst-1", "inst-2"],
      "stampsHash": "stamps:5f0e3c1a9b2d4e67",
      "pageStart": 41,
      "pageEnd": 45,
      "createdAt": "2026-02-01T03:21:00.000Z",
      "status": "processed"
    }
  ]
}
```

- `sourceHash`/`outputHash` は生成時点のファイル内容の `sha256:<hex>`。
  ファイルリストは、元 PDF の現在のハッシュを `sourceHash` と比較すること
  で「元 PDF が変更後」を検知します。
- `pageStart`/`pageEnd` は、`sequence.json` による通しページ番号でこの出力
  が生成された当時の範囲です。`sequence.json` の並び替え後にこの範囲が
  変わっていれば「並び替え後」として UI に表示されます。
- `stampsHash` は生成時の `stamps.json` の指紋（`stamps:<16 桁の hex>`）です。
  有効な配置とそれが使う定義から計算し、スタンプ名・説明・無効な配置・
  フォントのハッシュ記録は含みません。
- PDF タブのファイル一覧は、次のどれかに当てはまる出力を「要更新」と表示し、
  一括処理（「更新が必要なファイルを処理」）の対象にします。
  - 元 PDF の現在のハッシュが `sourceHash` と違う
  - 通しページ番号が `pageStart` と違う（`sequence.json` の並び替えなど）
  - 現在の `stamps.json` の指紋が `stampsHash` と違う（スタンプの変更）
  - 現在の出力パスが `output` と違う（CSV の再取り込みで出力名が変わった等）
- `stampsHash` の無い古いジョブは、スタンプの変更では「要更新」になりません。
