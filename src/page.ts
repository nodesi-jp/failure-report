/**
 * Failure Report の「ページ」（マトリクスの 1 マス = ケース × 対象）に何を載せるか。
 *
 * ここが唯一の定義。報告書（report.ts）・MCP（mcp.ts）・CLI（`failure-report page`）・
 * README はここを読む。項目を増やすときはここに足してから、それぞれに反映する。
 */

import fs from 'node:fs';
import path from 'node:path';

export type PageField = {
  /** 報告書の行見出し。そのまま表の左列になる */
  name: string;
  /** 何を書く欄か */
  meaning: string;
  /** テストのどこから来るか（テストを書く人向け） */
  source: string;
  /** 常に出るか、条件付きか */
  when?: string;
};

/** 結果の言葉。報告書・MCP・端末で同じ語を使う。 */
export const STATUS_LABEL: Record<string, string> = {
  passed: 'OK',
  failed: 'NG',
  timedOut: 'NG（タイムアウト）',
  // 「スキップ」ではない。実行できなかった＝ブロック。必ず理由がある
  skipped: 'ブロック',
  interrupted: '中断',
};

export const STATUS_WORDS: Array<{ word: string; playwright: string; meaning: string }> = [
  { word: 'OK', playwright: 'passed', meaning: '判定がすべて成立した' },
  { word: 'NG', playwright: 'failed', meaning: '判定が成立しなかった。落ちた手順・判定・エラーが「結果」に出る' },
  { word: 'NG（タイムアウト）', playwright: 'timedOut', meaning: '時間内に終わらなかった。NG として数える' },
  {
    word: 'ブロック',
    playwright: 'skipped',
    meaning: '実行できなかった（環境・前提・既知の不具合）。「スキップ」とは呼ばない。必ず「実行できない理由」が付く',
  },
  { word: '中断', playwright: 'interrupted', meaning: '実行そのものが途中で止まった' },
  { word: '対象外', playwright: '（収集しない）', meaning: 'そのロールにその画面が無い等。ページは作らず、マトリクスに「·」で出るだけ' },
];

/** ページに載せる項目。この順に並ぶ。 */
export const PAGE_FIELDS: PageField[] = [
  {
    name: 'お題',
    meaning: 'どのケースを、どの対象（ロール / 環境）で流したか。分類（機能 > 画面）も添える',
    source: "describe と test の名前、project 名、details({ 分類: ['機能', '画面'] })",
  },
  {
    name: '前提',
    meaning: '事前条件。使ったアカウント、用意したデータ、残っていてはいけないもの',
    source: "details({ 前提: '...' })",
  },
  {
    name: '内容',
    meaning: '手順。操作と、それで何を確かめたかを 1 文ずつ',
    source: "step('...', async () => {})",
  },
  {
    name: 'OK と判断した根拠 / NG と判断した根拠',
    meaning: '何をもって OK / NG としたか。判定 1 つずつの成否。poll の途中の空振りは「n 回目で成立」として出る',
    source: "expect(..., 'メッセージ') の並び。メッセージを書くと読める文になる",
    when: 'OK / NG のとき',
  },
  {
    name: '実行できない理由',
    meaning: 'なぜブロックなのか。理由が無いページが一番たちが悪い',
    source: "test.skip(条件, '理由') / test.fixme('理由') の理由",
    when: 'ブロックのとき',
  },
  {
    name: '実行の記録',
    meaning: '同じセッションで何回流したか。1 回目・2 回目…の結果と実行 ID',
    source: 'FAILURE_REPORT_SESSION で束ねた実行',
    when: '2 回以上流したとき',
  },
  {
    name: '再実行の結果',
    meaning: 'この回は NG だが、そのあと個別に流し直して通ったこと',
    source: '同じセッションの後続の実行',
    when: 'NG のあと通ったとき',
  },
  {
    name: '結果',
    meaning: 'OK / NG / ブロック、所要時間、エラー本文、メモ（数値・チェックサム・API 応答）',
    source: "Playwright の結果と note(testInfo, '題', '本文')",
  },
  {
    name: '要確認',
    meaning: '通っていても人に見てほしいこと（間欠的に落ちる、仕様が疑わしい）。報告書の先頭にも集まる',
    source: "issue(testInfo, '...')",
    when: '印を付けたとき',
  },
  {
    name: '参照',
    meaning: '仕様書・チケット・関連する不具合へのリンク',
    source: "details({ 参照: '...' })",
    when: '宣言したとき',
  },
  {
    name: 'DB の状態',
    meaning: '操作の前と後の一覧と、その差分（増えた・減った・変わった）',
    source: 'aroundState(testInfo, 名前, 読み取り, 操作) / recordState',
    when: '状態を撮ったとき',
  },
  {
    name: 'スクリーンショット',
    meaning: '要所の画面。「何をした直後か」がラベルで分かる',
    source: "shot(page, testInfo, 'ラベル')",
  },
];

/** lint が「足りない」と言う項目（ページとして最低限これが要る）。 */
export const REQUIRED_FIELDS = ['観点', '前提', '手順（内容）', '判定（根拠）', 'スクリーンショット'];

/** 端末・MCP に返すテキスト。 */
export function formatPageSpec(): string {
  const lines: string[] = [];
  lines.push('Failure Report のページ（マトリクスの 1 マス = ケース × 対象）に載せる項目');
  lines.push('');
  for (const f of PAGE_FIELDS) {
    lines.push(`${f.name}${f.when ? `（${f.when}）` : ''}`);
    lines.push(`  何を: ${f.meaning}`);
    lines.push(`  どこから: ${f.source}`);
  }
  lines.push('');
  lines.push('結果の言葉');
  for (const s of STATUS_WORDS) {
    lines.push(`  ${s.word}  [${s.playwright}]  ${s.meaning}`);
  }
  lines.push('');
  lines.push(`最低限（lint が見る）: ${REQUIRED_FIELDS.join(' / ')}`);
  lines.push(
    '章立て: 分類[0]（機能）→ 分類[1]（画面）→ 観点 → マトリクス（ケース × ロール）→ ページ',
  );
  lines.push(
    "分類は details({ 分類: ['機能', '画面'] })。書かなければ describe の入れ子を上から使う" +
      '（観点も宣言していなければ、一番内側の describe が観点になる）。',
  );
  return lines.join('\n');
}

/** お手本 spec（templates/example.spec.ts）。無ければ空。 */
export function exampleSpec(): string {
  const file = path.join(__dirname, '..', 'templates', 'example.spec.ts');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

/**
 * MCP の initialize で返す「使い方」。Claude Code はこれを
 * "MCP Server Instructions" として毎回プロンプトに載せる。
 */
export const MCP_INSTRUCTIONS = `FailureReport — Playwright の実行結果（Failure Report）を引くための道具。

聞かれたことに合わせてツールを選ぶ:
- 「落ちたのはどれ」「なぜ落ちた」 → get_failures（落ちた手順・判定・エラー）
- 「どんなテストがある」「この観点はカバーしているか」 → list_tests（実行せず、コードの宣言から答える）
- 「ロールごとの結果」「どの組み合わせが未確認か」 → get_matrix（viewpoint で観点を絞れる。row / column で軸を変えられる）
- 報告書の章立ては「分類（機能 > 画面）→ 観点 → ページ」。どこの話かを答えるときは分類から言う
- 「あるケースの詳細」 → get_run（status で passed / failed / skipped に絞る）
- 「実行の履歴」「前回との違い」 → list_runs → get_run
- 「報告書の書き方が足りていないところ」 → list_gaps
- 「人に渡す 1 ファイル」 → build_share
- 「ページ（1 マス）に何を載せるのか」「項目の意味」 → describe_page

言葉の対応（報告書と同じ語で答えること）:
  passed = OK / failed・timedOut = NG / skipped = ブロック（「スキップ」と言わない。必ず理由がある）/
  収集されていない組み合わせ = 対象外（ページは無い）

答えるときの決めごと:
- 実行 ID と対象（ロール・環境）を必ず添える。
- NG は「落ちた手順」「成立しなかった判定」「エラー」の 3 つで言う。推測で原因を足さない。
- ブロックは理由を添える。理由が無ければ「理由が記録されていない」と言う。
- 「通っているか」を聞かれたら、要確認（issue）も一緒に伝える。緑でも人に見てほしい印だから。

テストを書き足すときは、先に get_example でお手本 spec を読み、その形を真似る（全欄が埋まる 1 本とブロックの正しい形）。
各欄がどこから来るかは describe_page。足りているかは list_gaps。
書くときの決めごと（なぜ付き）は CLAUDE.md の「Failure Report」の節にある。無ければ「npx failure-report init --claude」で足せる。`;
