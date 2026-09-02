# @nodesi/failure-report

Playwright の実行から **Failure Report**（テスト報告書）を作る。

## 何ができるか

テストのそばに「観点・前提・手順・状態」を書いておくと、実行するたびに報告書ができる。

```
分類[0]（左メニューなど）             章立ての上の層
  └ 分類[1]（画面）                  章立ての下の層
      └ テスト観点                  何を確かめるのか
          └ テストマトリクス        観点ごとに「ケース × ロール（環境）」の表
              └ ページ（1 マス = ケース × 対象）
                  お題 / 前提 / 内容 / OK・NG と判断した根拠（ブロックなら実行できない理由）/
                  結果 / 要確認 / 参照 / DB の状態（操作前後の差分）/ スクリーンショット
```

- 表紙（`report.html`）に概要・要確認・前提・観点の一覧・マトリクス。観点名や記号を押すと、その観点のページへ
- 結果の言葉は **OK / NG / ブロック / 対象外**。「スキップ」とは言わない。ブロックには必ず理由が付く
- 実行ごとの記録は消さずに積む。「この版はここまで確認済み」を後から出せる
- 1 ファイルで渡したいときは `report --single`。印刷すれば PDF
- MCP サーバとしても動く。Claude Code から結果を直接引ける

依存は `@playwright/test` だけ。

## 入れかた

```bash
npm i -D github:nodesi-jp/failure-report
npx failure-report init --write --claude --example
```

`init` が `playwright.config.ts` に設定を足し（元は `.bak` に残る）、`--claude` が `CLAUDE.md` に書き方の決めごとを、
`--example` がお手本 spec を足す。何度流してもよい。

```bash
npx playwright test          # 流すたびに evidence/<実行ID>/report.html ができる
npx failure-report serve --open
npx failure-report --help    # コマンドと環境変数
```

## Claude Code から使う

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

使い方はサーバが自分で AI に伝える（ツールの一覧・言葉の対応・答え方・お手本）。
テストを書く側の決めごとは `init --claude` が CLAUDE.md に足す節にある。
