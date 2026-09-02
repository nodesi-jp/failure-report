import fs from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { EVIDENCE_ROOT, RUN_ID, SESSION_ID, linkLatest, paths } from './runContext';
import { formatBytes } from './transfer';
import { buildReport } from './report';
import { writeIndex, type Attachment, type CaseRecord, type CaseStep } from './site';
import { findGaps } from './lint';

type Row = { uploadBytes: number; uploadCount: number; downloadBytes: number; downloadCount: number };

export type FailureReportOptions = {
  /** 一覧ページの見出し。既定: 「自動テスト エビデンス」 */
  title?: string;
  /** 実行のたびに report.html（1 ファイルで渡せる Failure Report）も作る。既定: false */
  share?: boolean;
  /** 報告書に載せないプロジェクト（認証の下ごしらえなど）。既定: ['setup'] */
  exclude?: string[];
  /** 報告書の頭に載せる情報。 */
  report?: {
    /** 報告書のタイトル。既定「Failure Report」 */
    title?: string;
    /** 何のためのテストか。 */
    purpose?: string;
    /** テストの前提（環境・データ・アカウントなど、実行全体にかかるもの）。 */
    preconditions?: string[];
    /** テストの範囲（対象機能）。 */
    scope?: string[];
    /** 報告者。 */
    author?: string;
  };
};

/** テキストとして run.json に埋め込む添付の上限。 */
const INLINE_TEXT_LIMIT = 16 * 1024;

/**
 * 実行ごとのエビデンス一式をまとめるレポータ。
 *
 * - evidence/<実行ID>/ に レポート・スクショ・トレース・run.json を残す（上書きしない）
 * - evidence/index.html から過去の実行をたどれる
 *
 * 環境名は EVIDENCE_ENV_NAME で渡す（省略時は baseURL のホスト名）。
 */
export default class FailureReport implements Reporter {
  private startedAt = '';
  private startedMs = 0;
  private baseURL = '';
  private cases: CaseRecord[] = [];
  private tool: { playwright?: string; workers?: number; projects: string[] } = { projects: [] };

  constructor(private readonly options: FailureReportOptions = {}) {}

  onBegin(config: FullConfig) {
    fs.mkdirSync(paths.run, { recursive: true });
    this.startedAt = new Date().toISOString();
    this.startedMs = Date.now();
    this.baseURL = String(config.projects[0]?.use?.baseURL ?? '');
    this.tool = {
      playwright: config.version,
      workers: config.workers,
      projects: config.projects.map((p) => p.name).filter(Boolean),
    };
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? '';
    // 下ごしらえ（認証など）は通ったときだけ省く。落ちたときは
    // 「これが OK にならないと後続が実行できない」理由そのものなので残す
    if ((this.options.exclude ?? ['setup']).includes(project) && result.status === 'passed') return;

    // 手順（test.step）だけでなく判定（expect）も残す。
    // 「何をもって OK とした / NG とした」が報告書に出せないと、結果だけの紙になる。
    const flatten = (steps: TestResult['steps'], nest = 0): CaseStep[] =>
      steps
        .filter((s) => s.category === 'test.step' || s.category === 'expect')
        .flatMap((s) => [
          {
            title: s.title,
            durationMs: s.duration,
            error: s.error?.message?.split('\n')[0],
            kind: (s.category === 'expect' ? 'expect' : 'step') as 'step' | 'expect',
            nest,
          },
          ...flatten(s.steps, nest + 1),
        ]);

    this.cases.push({
      title: test.titlePath().filter(Boolean).slice(1).join(' › '),
      project,
      status: result.status,
      durationMs: result.duration,
      steps: flatten(result.steps),
      annotations: (result.annotations ?? test.annotations).map(
        (a) => `${a.type}: ${a.description ?? ''}`,
      ),
      attachments: result.attachments.map((a) => this.describeAttachment(a)),
      error: result.error?.message?.split('\n').slice(0, 3).join('\n'),
    });
  }

  onEnd(result: FullResult) {
    const transfer = this.readTransfer();
    const counts = this.cases.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});

    const envName =
      process.env.EVIDENCE_ENV_NAME ?? (this.baseURL ? new URL(this.baseURL).host : 'unknown');

    fs.writeFileSync(
      paths.meta,
      JSON.stringify(
        {
          runId: RUN_ID,
          session: SESSION_ID,
          environment: { name: envName, baseURL: this.baseURL },
          startedAt: this.startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - this.startedMs,
          status: result.status,
          counts,
          tool: this.tool,
          report: this.options.report ?? {},
          transfer: {
            ...transfer,
            upload: formatBytes(transfer.uploadBytes),
            download: formatBytes(transfer.downloadBytes),
          },
          cases: this.cases,
        },
        null,
        2,
      ),
    );

    const gaps = findGaps({ cases: this.cases } as never);
    if (gaps.length) {
      console.log(
        `\n報告書の記述が足りないケース: ${gaps.length} 件（npx failure-report lint で内訳）`,
      );
    }

    linkLatest();

    const wantShare = this.options.share ?? process.env.EVIDENCE_SHARE === '1';
    if (wantShare) {
      try {
        buildReport(EVIDENCE_ROOT, RUN_ID);
      } catch (e) {
        console.warn(`共有用レポートを作れませんでした: ${(e as Error).message}`);
      }
    }

    writeIndex(EVIDENCE_ROOT, this.options.title);

    const rel = (p: string) => path.relative(process.cwd(), p);
    console.log(`\nエビデンス: ${rel(paths.run)}/`);
    console.log(`  レポート: ${rel(paths.report)}/index.html`);
    console.log(`  一覧    : ${rel(EVIDENCE_ROOT)}/index.html`);
    if (wantShare) console.log(`  Failure Report: ${rel(path.join(paths.run, 'report.html'))}`);
    console.log(`  共有    : npx failure-report serve  /  npx failure-report publish --to <置き場所>`);
  }

  /** 添付を run.json 用に記述する。実体があれば実行フォルダからの相対パスで残す。 */
  private describeAttachment(a: TestResult['attachments'][number]): Attachment {
    const out: Attachment = { name: a.name, contentType: a.contentType };
    if (a.path) {
      const rel = path.relative(paths.run, a.path);
      out.path = rel.startsWith('..') ? a.path : rel;
    }
    const inlinable = a.contentType.startsWith('text/') || a.contentType === 'application/json';
    if (a.body && inlinable && a.body.length <= INLINE_TEXT_LIMIT) {
      out.body = a.body.toString('utf-8');
    }
    return out;
  }

  private readTransfer(): Row {
    const empty: Row = { uploadBytes: 0, uploadCount: 0, downloadBytes: 0, downloadCount: 0 };
    if (!fs.existsSync(paths.transfer)) return empty;
    return fs
      .readdirSync(paths.transfer)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(paths.transfer, f), 'utf-8')) as Row)
      .reduce(
        (a, r) => ({
          uploadBytes: a.uploadBytes + r.uploadBytes,
          uploadCount: a.uploadCount + r.uploadCount,
          downloadBytes: a.downloadBytes + r.downloadBytes,
          downloadCount: a.downloadCount + r.downloadCount,
        }),
        empty,
      );
  }
}
