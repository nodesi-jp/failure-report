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
npx failure-report init --write --claude --example --mcp
```

`init` が `playwright.config.ts` に設定を足し（元は `.bak` に残る）、`--claude` が `CLAUDE.md` に書き方の決めごとを、
`--example` がお手本 spec を、`--mcp` が `.mcp.json` に MCP サーバを足す。何度流してもよい。

```bash
npx playwright test          # 流すたびに evidence/<実行ID>/report.html ができる
npx failure-report serve --open
npx failure-report --help    # コマンドと環境変数
```

## CLI

<!-- help:begin -->
```
failure-report — Playwright の実行から Failure Report（テスト報告書）を作る・見る・配る

  npx failure-report <コマンド> [オプション]

コマンド
  init [--write] [--claude] [--example] [--mcp]
                                 このプロジェクトに導入する（設定への追記を表示、--write で書き込む）
                                 --claude   CLAUDE.md に書き方の決めごとを足す（何度流しても増えない）
                                 --example  お手本 spec を testDir に写す
                                 --mcp      .mcp.json に MCP サーバを登録する
  list [-n <件数>]                実行の一覧を表示する
  serve [--port 4321] [--host]   ブラウザで見る（--host 0.0.0.0 で LAN のチームにも見せられる）
  report [<実行ID>] [--single]    Failure Report を作る（観点ごとに別ページ。--single で 1 ファイル、
                                 印刷して PDF にもできる）
                                 軽くする: --max-mb 8 / --max-images 4 / --no-images
                                 画像の枠は失敗したケースから先に使う
  matrix [<実行ID>] [--html]      マトリクスを出す（既定は観点ごとにケース × ロール）
                                 --viewpoint <語> で観点を絞る
                                 --row <軸> --col <軸> で好きな軸に組み替える
                                 （軸はテストが details({軸:{...}}) で宣言したもの、
                                   ほかに ロール / 観点 / ファイル / ケース）
                                 --all-envs で環境も並べる
  catalog                        どんなテストがあり、何を確かめることになっているかを
                                 実行せずに観点ごとに並べる
  page                           ページ（マトリクスの 1 マス）に載せる項目と、結果の言葉
                                 （OK / NG / ブロック / 対象外）の定義を出す
  practices                      テストを書くときの決めごと（init --claude が CLAUDE.md に足す文）を出す
  example                        お手本 spec を出す（報告書の全欄が埋まる 1 本とブロックの形）
  lint [<実行ID>] [--strict]      報告書の記述（観点・前提・手順・スクショ）が
                                 足りていないケースを挙げる（--strict で CI を落とせる）
  publish --to <置き場所>         共有できる場所へ静的サイトとして置く
  prune --keep <n> [--yes]       古い実行を消す（既定は消さずに一覧だけ表示）
  index                          一覧ページ（index.html）を作り直す
  open [<実行ID>]                 レポートをブラウザで開く
  mcp                            MCP サーバとして動く（Claude Code から結果を引ける）

Claude Code から使う
  claude mcp add failure-report -- npx failure-report mcp

置き場所（publish --to）
  <ディレクトリ>                  そのフォルダへコピーする（共有ドライブなど）
  s3://<bucket>/<prefix>         aws s3 sync で上げる（AWS CLI が要る）
  gh-pages                       gh-pages ブランチへコミットする（--push で送信まで）

共通オプション
  --dir <evidence>               エビデンスの場所（既定 ./evidence、環境変数 EVIDENCE_DIR）
  --runs latest|all|<実行ID>      publish の対象（既定 latest）
  --light                        トレース・動画を含めない（軽くする）

環境変数
  EVIDENCE_DIR                   保存先（既定 <プロジェクト直下>/evidence）
  EVIDENCE_RUN_ID                実行 ID（既定 実行時刻。CI ではビルド番号でもよい）
  EVIDENCE_ENV_NAME              一覧に出す環境名（既定 baseURL のホスト名）
  EVIDENCE_SHARE                 1 で実行のたびに報告書も作る（reporter の share でも指定できる）
  FAILURE_REPORT_SESSION         「全部流す → 落ちたものを流し直す」を 1 冊にまとめる名前
```
<!-- help:end -->

## Claude Code から使う

`init --mcp` が `.mcp.json` に登録する。手で登録するなら:

```bash
claude mcp add failure-report -- npx failure-report mcp
```

あとは普通に頼むだけでよい。使い方はサーバが自分で AI に伝えるので、呼び方を覚える必要はない。

| 頼み方 | 何が起きるか |
|---|---|
| 「昨日の実行で落ちたのはどれ？」 | `get_failures` で NG のケースを、落ちた手順・判定・エラーつきで答える |
| 「共有の権限はテストでカバーしてる？」 | `list_tests` で、実行せずに観点の宣言から答える |
| 「一般ユーザーで未確認の画面は？」 | `get_matrix` でロール別の表を出して答える |
| 「受信一覧のテストを書き足して」 | `get_example` でお手本を読み、CLAUDE.md の決めごとに沿って書く |
| 「報告書に足りないところは？」 | `list_gaps` で観点・前提・手順・判定・スクショの抜けを挙げる |
| 「報告書を 1 ファイルにして」 | `build_share` で `report.html` を作ってパスを返す |

結果は OK / NG / ブロック / 対象外 の言葉で返ってくる（報告書と同じ）。
テストを書く側の決めごとは `init --claude` が CLAUDE.md に足す節にある。
