import fs from 'node:fs';
import path from 'node:path';

/**
 * 実行ごとのエビデンス保管先。
 *
 * 上書きしないこと。過去の実行の証拠を後から出せる必要がある。
 * 実行 ID は playwright.config.ts の読み込み時（親プロセス）に決まり、
 * 環境変数でワーカーへ引き継ぐ（ワーカーが別々に採番しないように）。
 *
 * 保存先は EVIDENCE_DIR で変えられる（既定: <プロジェクト直下>/evidence）。
 */
export const EVIDENCE_ROOT = path.resolve(process.env.EVIDENCE_DIR ?? path.join(process.cwd(), 'evidence'));

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

if (!process.env.EVIDENCE_RUN_ID) {
  process.env.EVIDENCE_RUN_ID = newRunId();
}

export const RUN_ID = process.env.EVIDENCE_RUN_ID;

/**
 * テストセッション。
 *
 * 「全部流す → 落ちたものを個別に流し直す」までを 1 つの塊として扱うための ID。
 * 同じセッションの実行は 1 冊の報告書にまとまり、ケースごとに 1 回目・2 回目…が並ぶ。
 * 指定しなければ、その実行だけで 1 セッション。
 *
 *   export FAILURE_REPORT_SESSION=2026-09-01-リリース確認
 *   npx playwright test                  # 1 回目
 *   npx playwright test -g "落ちたやつ"   # 2 回目
 *   npx failure-report report                  # セッションとしてまとめる
 */
export const SESSION_ID = process.env.FAILURE_REPORT_SESSION || resolveSession();

/**
 * 一部だけ流したのか（-g やファイル指定）を、起動時の引数から見る。
 * 一部実行は「新しいセッション」にはできない。全部流していない結果を
 * 1 冊の報告書の起点にすると、確認していない範囲が消えるため。
 */
function isPartialRun(): boolean {
  const args = process.argv.slice(2).filter((a) => a !== 'test');
  return args.some(
    (a) =>
      /^(-g|--grep|--grep-invert|--project|--shard|--last-failed|--only-changed)/.test(a) ||
      (!a.startsWith('-') && !/playwright/.test(a)),
  );
}

/** 直近のセッション（一部実行のときに乗せる先）。 */
function latestSession(): string | null {
  try {
    const runs = fs
      .readdirSync(EVIDENCE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'latest')
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const id of runs) {
      const file = path.join(EVIDENCE_ROOT, id, 'run.json');
      if (!fs.existsSync(file)) continue;
      const meta = JSON.parse(fs.readFileSync(file, 'utf-8')) as { session?: string; runId?: string };
      return meta.session ?? meta.runId ?? id;
    }
  } catch {
    /* 読めなければ新規セッション扱い */
  }
  return null;
}

function resolveSession(): string {
  // 全部流したら新しいセッション。一部だけなら直近のセッションの続き
  if (!isPartialRun()) return RUN_ID;
  return latestSession() ?? RUN_ID;
}
export const RUN_DIR = path.join(EVIDENCE_ROOT, RUN_ID);

export const paths = {
  run: RUN_DIR,
  shots: path.join(RUN_DIR, 'shots'),
  report: path.join(RUN_DIR, 'report'),
  artifacts: path.join(RUN_DIR, 'artifacts'),
  results: path.join(RUN_DIR, 'results.json'),
  transfer: path.join(RUN_DIR, 'transfer'),
  meta: path.join(RUN_DIR, 'run.json'),
};

/** evidence/latest を最新の実行に向ける。 */
export function linkLatest(): void {
  const latest = path.join(EVIDENCE_ROOT, 'latest');
  try {
    fs.rmSync(latest, { recursive: true, force: true });
    fs.symlinkSync(RUN_DIR, latest);
  } catch {
    /* シンボリックリンクが張れない環境では諦める */
  }
}
