# @nodesi/failure-report

Playwright の実行から **Failure Report**（テスト報告書）を作る部品。

- テストのそばに「観点・前提・手順・状態」を書いておくと、実行するたびに報告書ができる
- 報告書は 1 ファイル（`report.html`）で完結する。メールにもチケットにも貼れる。印刷すれば PDF
- 実行ごとの記録は消さずに積む。過去の「この版はここまで確認済み」を後から出せる
- CLI で見る・配る。MCP サーバとしても動くので、Claude Code から結果を直接引ける

依存は `@playwright/test` だけ。

## Failure Report の構造

```
分類[0]（機能）                      章立ての上の層（details({ 分類 })）
  └ 分類[1]（画面）                  章立ての下の層
      └ テスト観点                  何を確かめるのか（details({ 観点 })）
          └ テストマトリクス        観点ごとに「ケース × ロール（環境）」の表
              └ ページ（マトリクスの 1 マス = ケース × 対象）
```

ページに載るもの:

```
お題                    どのケースを、どの対象（ロール / 環境）で流したか。分類も添える
前提                    事前条件・使ったアカウント・用意したデータ（details({ 前提 })）
内容                    手順。操作と、それで何を確かめたかを 1 文ずつ（step）
OK / NG と判断した根拠  判定 1 つずつの成否（expect のメッセージ）。poll の空振りは「n 回目で成立」
実行できない理由        ブロックのときだけ。test.skip / test.fixme の理由（必須）
実行の記録              同じセッションで 2 回以上流したときの 1 回目・2 回目…
再実行の結果            この回 NG でも、あとで個別に流して通ったこと
結果                    OK / NG / ブロック・所要時間・エラー本文・メモ（note）
要確認                  通っていても人に見てほしいこと（issue）。報告書の先頭にも集まる
参照                    仕様書・チケットへのリンク（details({ 参照 })）
DB の状態               操作前後の差分（増えた・減った・変わった）（aroundState）
スクリーンショット      要所の画面（shot）。「何をした直後か」がラベルで分かる
```

マトリクスの記号をクリックすると、その 1 マスの詳細へ飛ぶ。

### 章立て（分類）

`details({ 分類: ['ファイル共有', '受信一覧'] })` で「機能 > 画面」を宣言すると、報告書がその順に
`4.1 ファイル共有` → `4.1.2 受信一覧` → `4.1.2.1 観点: …` → ページ、と入れ子になる。2 層まで。

書かなければ **describe の入れ子をそのまま章立てにする**。観点も宣言していなければ、
一番内側の describe が観点になる。つまり次の 2 つは同じ報告書になる。

```ts
// 宣言する
test.describe('受信一覧', details({ 分類: ['ファイル共有', '受信一覧'], 観点: '権限' }), () => { ... });

// describe の入れ子に任せる
test.describe('ファイル共有', () => {
  test.describe('受信一覧', () => {
    test.describe('権限', () => { ... });
  });
});
```

結果の言葉は報告書・端末・MCP で揃えている。

| 言葉 | Playwright | 意味 |
|---|---|---|
| OK | passed | 判定がすべて成立した |
| NG | failed / timedOut | 判定が成立しなかった。落ちた手順・判定・エラーが「結果」に出る |
| ブロック | skipped | 実行できなかった。「スキップ」とは呼ばない。必ず「実行できない理由」が付く |
| 対象外 | （収集しない） | そのロールにその画面が無い等。ページは作らず、マトリクスに「·」で出るだけ |

## 入れかた

```bash
npm i -D github:nodesi-jp/failure-report   # GitHub から（npm 公開までの間はこちら）
# npm i -D @nodesi/failure-report          # npm に公開したらこちら
npx failure-report init --write --claude --example
```

`init` が `playwright.config.ts` に 3 か所（`outputDir` / `reporter` / `use` の証拠設定）を足す
（元のファイルは `.bak` に残る）。`--claude` は `CLAUDE.md` に書き方の決めごとを、
`--example` はお手本 spec を足す。**何度流してもよい**（節は印で囲ってあり、増えずに最新へ置き換わる）。

手で書くならこれだけ:

```ts
import { defineConfig } from '@playwright/test';
import { paths } from '@nodesi/failure-report/runContext';

export default defineConfig({
  outputDir: paths.artifacts,                       // 実行ごとのフォルダへ
  reporter: [
    ['html', { open: 'never', outputFolder: paths.report }],
    ['list'],
    ['@nodesi/failure-report/reporter', {
      share: true,                                  // 実行のたびに report.html を作る
      report: {
        title: 'Failure Report',
        purpose: '何のためのテストか',
        scope: ['対象機能'],
        preconditions: ['環境・データ・アカウントの前提'],
      },
    }],
  ],
  use: { trace: 'on', screenshot: 'on', video: 'retain-on-failure' },
});
```

## テストの書き方

**動くお手本が付いている。** ページの全欄が埋まる 1 本と、ブロック（理由付きの `test.skip`）の
正しい形が入っている。ネットワークも認証も要らないので、そのまま流せる。

```bash
npx failure-report init --example     # testDir に写す
npx playwright test failure-report.example
```

骨格はこれだけ。観点と前提は **Playwright 標準のアノテーション枠**（`details`）に書く。
describe に書けば中の全ケースに付く。

```ts
import { details, step, shot, note, issue, aroundState } from '@nodesi/failure-report';

test.describe('ToDo の追加と削除', details({
  分類: ['ToDo', '一覧画面'],
  観点: '追加したものが一覧に出て、削除すると消える',
  前提: '一覧に 2 件だけがある状態',
}), () => {

test('追加した ToDo が一覧に出て、削除すると消える', async ({ page }, testInfo) => {

  await aroundState(testInfo, 'ToDo 一覧', () => readTodos(page), () =>
    step('「掃除をする」を追加して、一覧に 3 件目として出ることを確かめる', async () => {
      await page.getByRole('button', { name: '追加' }).click();
      await shot(page, testInfo, '追加した直後の一覧');
      await expect(page.getByText('掃除をする'), '追加した ToDo が一覧に出ること').toBeVisible();
    }),
  );

  await note(testInfo, '最終的な一覧', JSON.stringify(await readTodos(page)));
  issue(testInfo, '追加が一覧に反映されるまで 300ms かかる。仕様確認が要る');
});
});
```

| 関数 | 報告書のどこに出るか | 書き方 |
|---|---|---|
| `details({分類})` | 章立て（機能 > 画面）。2 層まで | `分類: ['ファイル共有', '受信一覧']`。書かなければ describe の入れ子を使う |
| `details({観点, 前提, 参照, 要確認})` | 章立ての一番下・マトリクスの行のまとまり・各マスの前提 | `test.describe(名前, details({...}), () => {})` / `test(名前, details({...}), async () => {})`。**実行しなくても `--list` で読める**ので、これが基本 |
| `viewpoint` / `precondition` / `reference` (testInfo, ...) | 同上 | 実行してみないと決まらないときだけ。静的には読めない |
| `step(title, body)` | 各マスの「内容」 | **操作と、それで何を確かめたかを 1 文で**。「クリック」「アサート」は書かない |
| `shot(page, testInfo, label)` | 「スクリーンショット」 | 「何をした直後の画面か」。連番は自動 |
| `issue(testInfo, ...)` | 報告書の先頭「要確認」 | 通っているが人に見てほしいこと（間欠的に落ちる・仕様が疑わしい） |
| `note(testInfo, title, text)` | 「結果」の折りたたみ | 数値・チェックサム・API 応答 |
| `recordState(testInfo, name, '前'\|'後', data)` | 「DB の状態」 | 状態そのもの（配列・オブジェクト） |
| `aroundState(testInfo, name, read, body)` | 「DB の状態」の差分表 | 操作の前後を自動で撮る |

手順名の善し悪しがそのまま報告書の読みやすさになる。

- よい: `ファイルを2つアップロードして、一覧に両方出ることを確かめる`
- よい: `権限のない画面を直接開いて、データが返らないことを確かめる`
- わるい: `click upload button` / `assert visible` / `step 1`

「DB を直接見る口」が無くても、API や画面から取れる一覧を前後で撮れば差分は出せる。
配列は `id` / `name` などをキーに突き合わせ、**追加・削除・変更**が表になる。
オブジェクトはフィールドごとに比べる。生データも折りたたみで残る。

書き忘れは `npx failure-report lint` が挙げる（観点・前提・手順・判定・スクショの抜け）。
CI に `lint --strict` を入れれば落とせる。

## 出来上がるもの

```
evidence/
├── index.html                    過去の実行の一覧（実行ID・環境・結果・所要・転送量・報告書）
├── latest → 2026-08-31_212000    最新へのリンク
└── 2026-08-31_212000/            実行ごと。上書きしない
    ├── report.html               テスト報告書（1 ファイルで完結、画像埋め込み）
    ├── run.json                  機械可読の実行記録（環境・結果・観点・手順・添付）
    ├── report/index.html         Playwright の HTML レポート（トレース閲覧はこちら）
    ├── shots/                    要所のスクリーンショット（連番＋日本語ラベル）
    └── artifacts/                トレース・動画・添付
```

## CLI

`npx failure-report <コマンド>`。全部は `--help` に出る。よく使うのは:

| コマンド | すること |
|---|---|
| `report [<実行ID>]` | 報告書 `report.html` を作る（`--no-images` で軽く） |
| `serve [--host 0.0.0.0] [--open]` | ブラウザで見る |
| `matrix [--viewpoint <語>] [--all-envs]` | 観点 × ロール（環境）のマトリクスを端末に |
| `catalog` | どんなテストがあり何を確かめることになっているかを、**実行せずに**並べる |
| `lint [--strict]` | 記述が足りないケースと、続けてブロックされたままのテスト |
| `page` / `practices` / `example` | ページの項目の定義 / 書き方の決めごと / お手本 spec |
| `publish --to <置き場所>` | 共有できる場所へ静的サイトとして置く |
| `prune --keep 10 [--yes]` | 古い実行を消す（既定は一覧を出すだけ） |

配るとき:

| したいこと | やりかた |
|---|---|
| 1 人に渡す | `report` で `report.html` を作って添付（画像込み。印刷で PDF） |
| チームで見る | `serve --host 0.0.0.0`（その場だけ）|
| URL で常設 | `publish --to s3://bucket/prefix` / `publish --to gh-pages --push` / `publish --to <共有フォルダ>` |

## Claude Code から使う（MCP）

```bash
claude mcp add failure-report -- npx failure-report mcp
```

`.mcp.json` に書くなら:

```json
{
  "mcpServers": {
    "failure-report": { "command": "npx", "args": ["failure-report", "mcp"] }
  }
}
```

ツールの一覧と使い方・言葉の対応・答え方は、**サーバが自分で AI に伝える**
（`tools/list` と initialize の `instructions`）。ここに書き写さないので、ずれない。

`get_run` / `get_failures` は報告書のページと同じ項目の順で返す。
人が `report.html` で見るものと、AI が読むものが一致する。

## 設定

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `EVIDENCE_DIR` | `<プロジェクト直下>/evidence` | 保存先 |
| `EVIDENCE_RUN_ID` | 実行時刻 | 実行 ID。CI ではビルド番号を入れてもよい |
| `EVIDENCE_ENV_NAME` | baseURL のホスト名 | 一覧に出す環境名（stg / prod など） |
| `EVIDENCE_SHARE` | `0` | `1` で実行のたびに報告書も作る（reporter の `share` でも指定できる） |
| `FAILURE_REPORT_SESSION` | その実行だけ | 「全部流す → 落ちたものを流し直す」を 1 冊にまとめる名前。同じ値の実行がケースごとに 1 回目・2 回目…として並ぶ |

reporter のオプション: `title` / `share` / `exclude`（報告書に載せないプロジェクト、既定 `['setup']`）/
`report.{title,purpose,scope,preconditions,author}`。

アップロード / ダウンロードの転送量も記録できる。fixture に `trackTransfer(page, testInfo)` を仕込むと、
実バイト数が一覧と報告書に出る（判定を変えるなら `{ isUpload }` に述語を渡す）。
