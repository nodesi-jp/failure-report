## Failure Report（@nodesi/failure-report）

テストを書き足すときは、Failure Report のページ（マトリクスの 1 マス = ケース × 対象）が埋まるように書く。
**お手本は `tests/failure-report.example.spec.ts`**（無ければ `npx failure-report init --example` で写す。MCP なら `get_example`）。その形を真似る。
ページの項目は `npx failure-report page`（MCP なら `describe_page`）で出る。順に:
お題 → 前提 → 内容 → OK / NG と判断した根拠（ブロックなら「実行できない理由」）→ 結果 → 要確認 → 参照 → DB の状態 → スクリーンショット。
結果の言葉は OK / NG / ブロック / 対象外（「スキップ」と言わない。ブロックには必ず理由が付く）。

```ts
import { details, shot, step, note, issue, aroundState } from '@nodesi/failure-report';

test.describe('プロジェクトの作成と削除', details({
  観点: 'プロジェクト管理: 作成したものが一覧に出て、削除すると消える',
  前提: 'e2e- で始まるプロジェクトが残っていない状態',
}), () => {

test('作成したプロジェクトが一覧に出て、削除すると消える', async ({ page }, testInfo) => {
  await aroundState(testInfo, 'プロジェクト一覧', () => listProjects(page), () =>
    step('プロジェクトを新規作成して、一覧に出ることを確かめる', async () => {
      await projects.createProject(name);
      await shot(page, testInfo, '作成直後の一覧');
      await expect(...).toBeVisible();
    }),
  );
});
```

- `details({観点, 前提})` — **何を確かめるテストか**と事前条件。describe に書けば中の全ケースに付く。
  Playwright 標準のアノテーション枠なので、**テストを実行しなくても `--list` から読める**。
  報告書はこれで章立てされ、マトリクスの行がまとまる。
- `issue(testInfo, '...')` — 通っているが人に見てほしいこと（間欠的に落ちる等）。報告書の先頭に出る。
- `step` — 手順。**操作と、それで何を確かめたかを 1 文で**。「クリック」「アサート」は書かない。
  - よい: `ファイルを2つアップロードして、一覧に両方出ることを確かめる`
  - わるい: `click upload button`
- `shot` — 「何をした直後の画面か」が分かるラベルで撮る。連番は自動。
- `note` — 数値・チェックサム・API 応答。
- `aroundState` — 操作の前後の状態（DB / API から取った一覧）。報告書に差分表が出る。

### 報告書に載せるための決めごと（なぜ、まで含めて）

テストの方針（後始末・並列・検証の仕方）はプロジェクト側で決める。ここにあるのは報告書の入力になる書き方だけ。

- **1 テストに 1 観点。`details({観点, 前提})` で宣言する。** 関数版 `viewpoint(testInfo, ...)` は使わない。
  実行するまで注記が生まれず、`--list` や `failure-report catalog` から「何をカバーしているか」が読めなくなる。
- **対象外はスキップせず、そもそも収集しない。** `testIgnore` でファイルごと外す。
  skip が並ぶと、報告書で「確認できていない」のか「対象外」なのかが読めなくなる。
- **ブロックには必ず理由を書く。** `test.skip(条件, '理由')` / `test.fixme('理由')`。
  理由の無いブロックは報告書に「理由が記録されていない」と赤く出る。
- **`expect` にはメッセージを書く。** 「OK / NG と判断した根拠」がそのまま読める文になる。
  無いと `getByRole(...)` のセレクタが並ぶだけになる。
- **通っていても引っかかったら `issue(testInfo, '...')` で印を付ける。**
  報告書の先頭「要確認」に出る。間欠的に落ちる・仕様が疑わしい、を握り潰さないため。
- **結果の言葉は OK / NG / ブロック / 対象外。「スキップ」と言わない。**
  報告書・端末・MCP で同じ語を使う（`failure-report page` に定義がある）。
- **足りているかは `failure-report lint` が教える。** CI では `lint --strict` で落とす。
  見るのは観点・前提・手順・判定・スクリーンショットの 5 つ。

この節は `npx failure-report init --claude` が書く。何度実行しても重複せず、最新の文面に置き換わる。

確認のしかた:

```bash
npx failure-report page          # ページに載せる項目と結果の言葉の定義
npx failure-report catalog       # どんなテストがあるか（実行不要）
npx failure-report lint          # 観点・前提・手順・スクショの抜け
npx failure-report list          # 実行履歴
npx failure-report matrix        # 観点 × ロールのマトリクス（端末）
npx failure-report report        # Failure Report（report.html）を作る
npx failure-report serve --open  # ブラウザで見る
```

失敗を調べるときは `evidence/<実行ID>/report/index.html`（Playwright のレポート）にトレースがある。
