import fs from 'node:fs';
import path from 'node:path';
import {
  buildAxisMatrix,
  buildMatrix,
  caseAnchor,
  declaredViewpointsOf,
  groupByViewpoint,
  renderAxisMatrixHtml,
  renderMatrixHtml,
  renderMatrixTable,
  viewpointsOf,
  type Matrix,
} from './matrix';
import { diffState, renderStateHtml } from './diff';
import { inferSkipReason } from './lint';
// 結果の言葉は page.ts が唯一の定義（報告書・MCP・端末で同じ語を使う）
import { STATUS_LABEL } from './page';
import type { CaseStep } from './site';
import {
  STYLE,
  escapeHtml,
  formatDuration,
  listRuns,
  resolveRun,
  runsInSession,
  type Attachment,
  type CaseRecord,
  type RunMeta,
} from './site';

export type ReportOptions = {
  /** 出力先。既定は実行フォルダの report.html */
  out?: string;
  /** スクリーンショットを埋め込むか。既定 true（false にすると数十 KB で済む） */
  images?: boolean;
  /** 1 ケースあたりに埋め込むスクリーンショットの上限。既定 12 */
  maxImagesPerCase?: number;
  /** 埋め込む画像の合計サイズの上限（バイト）。既定 24MB */
  maxTotalImageBytes?: number;
};


const VIEWPOINT = '観点';
const PRECONDITION = '前提';
const REFERENCE = '参照';
const ISSUE = '要確認';

/**
 * テスト報告書を 1 ファイルで作る。
 *
 * 中身は「テスト前提 → テスト観点 → テストマトリクス → テスト内容と結果
 * （手順・スクリーンショット・操作前後の状態）」。画像は埋め込むので、
 * このファイルだけメール・チケット・Slack に添付すれば渡せる。印刷して PDF にもできる。
 */
export function buildReport(root: string, runId?: string, options: ReportOptions = {}): string {
  const { id, dir, meta } = resolveRun(root, runId);

  // 同じテストセッションの実行（1 回目・2 回目…）をまとめて 1 冊にする。
  // ケースごとに最後の結果を採り、途中の結果は「試行」として残す。
  const session = meta.session ?? id;
  const sessionRuns = runsInSession(root, session);
  const attempts = new Map<string, Array<{ runId: string; status: string }>>();
  const latest = new Map<string, { c: CaseRecord; dir: string; runId: string }>();
  for (const r of sessionRuns.length ? sessionRuns : [{ id, dir, meta }]) {
    for (const c of r.meta.cases ?? []) {
      const key = caseAnchor('', c.project, c.title);
      attempts.set(key, [...(attempts.get(key) ?? []), { runId: r.id, status: c.status }]);
      latest.set(key, { c, dir: r.dir, runId: r.id });
    }
  }
  const dirOf = (anchor: string) => latest.get(anchor)?.dir ?? dir;
  const state = {
    images: options.images ?? true,
    maxPerCase: options.maxImagesPerCase ?? 12,
    budget: { left: options.maxTotalImageBytes ?? 24 * 1024 * 1024, skipped: 0 },
  };

  const title = meta.report?.title ?? 'Failure Report';
  const cases = latest.size ? [...latest.values()].map((v) => v.c) : (meta.cases ?? []);
  const matrix = buildMatrix([{ id, dir, meta: { ...meta, cases } }]);
  const failures = classifyFailures(root, id, cases);
  // この実行のあとに個別に流し直して OK になったものを拾う
  const resolved = findResolutions(root, id, cases);
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8">
<title>${escapeHtml(title)} ${escapeHtml(id)}</title>
<style>${STYLE}${PRINT_STYLE}</style>
<div class="wrap">
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(meta.environment?.name ?? '')} 環境 ／ ${escapeHtml(formatDate(meta.startedAt))} 実行 ／ セッション ${escapeHtml(session)}${
    sessionRuns.length > 1 ? `（${sessionRuns.length} 回の実行をまとめています）` : ''
  }${
    meta.report?.author ? ` ／ 報告者 ${escapeHtml(meta.report.author)}` : ''
  }</p>
${renderSummary(meta, failures, resolved, cases)}
${renderFailures(id, failures, resolved)}
${renderIssues(id, cases)}
<h2>1. テスト前提</h2>
${renderPreconditions(meta, cases)}
<h2>2. テスト観点</h2>
${renderViewpoints(cases)}
<h2>3. テストマトリクス</h2>
${renderMatrices(id, matrix, cases) || '<p class="lede">ケースがありません</p>'}
<h2>4. テストケースごとの詳細</h2>
${renderDetails(id, dir, matrix, cases, state, resolved, attempts, dirOf)}
<p class="lede" style="margin-top:32px">このファイル 1 つで完結しています（スクリーンショット埋め込み済み）。
操作の記録（トレース）と動画は実行フォルダ <code>${escapeHtml(id)}/</code> にあります。</p>
</div></html>`;

  const out = options.out ?? path.join(dir, 'report.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  if (state.budget.skipped) {
    console.warn(`画像 ${state.budget.skipped} 枚は容量の上限を超えたため省きました（--no-images で全部省けます）`);
  }
  return out;
}

/** 旧名。 */
export const buildShare = buildReport;
export type ShareOptions = ReportOptions;

/* ------------------------------------------------------------------ 概要 */

function renderSummary(
  meta: RunMeta,
  failures: Failure[],
  resolved: Map<string, Resolution>,
  cases: CaseRecord[],
): string {
  const counts = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  const failed = (counts.failed ?? 0) + (counts.timedOut ?? 0);
  const fresh = failures.filter((f) => !f.known).length;
  const known = failures.length - fresh;
  const resultText = failed
    ? `<span class="ng">失敗 ${failed}</span><span class="muted" style="font-size:11px"> 新規 ${fresh} / 既知 ${known}</span>`
    : '<span class="ok">全て OK</span>';
  return (
    '<div class="cards">' +
    [
      ['結果', resultText],
      ['OK', String(counts.passed ?? 0)],
      ['ブロック', String(counts.skipped ?? 0)],
      ['所要', formatDuration(meta.durationMs)],
      ['アップロード', escapeHtml(meta.transfer?.upload ?? '-')],
      ['ダウンロード', escapeHtml(meta.transfer?.download ?? '-')],
    ]
      .map(([label, value]) => `<div class="card"><span>${label}</span><b>${value}</b></div>`)
      .join('') +
    '</div>'
  );
}

export type Failure = {
  case: CaseRecord;
  anchor: string;
  /** 前の実行でも同じところが落ちていたか */
  known: boolean;
  /** 連続で落ちている回数 */
  streak: number;
  /** 直近で通っていた実行 ID（無ければ null） */
  lastPassed: string | null;
};

/**
 * 失敗を「既知」と「新規」に分ける。
 *
 * リリース判断では「前から落ちているもの」と「今回壊れたもの」を混ぜてはいけない。
 * 過去の実行記録を遡って、同じケースが前回どうだったかで判定する。
 */
function classifyFailures(root: string, runId: string, cases: CaseRecord[]): Failure[] {
  const isFail = (status: string) => status !== 'passed' && status !== 'skipped';
  const failed = cases.filter((c) => isFail(c.status));
  if (!failed.length) return [];

  // この実行より前のものを新しい順に
  const past = listRuns(root).filter((r) => r.id < runId);

  return failed.map((c) => {
    let streak = 1;
    let lastPassed: string | null = null;
    let counting = true;
    for (const r of past) {
      const before = (r.meta.cases ?? []).find((x) => x.project === c.project && x.title === c.title);
      if (!before || before.status === 'skipped') continue;
      if (isFail(before.status)) {
        if (counting) streak++;
      } else {
        lastPassed = r.id;
        break;
      }
      counting = true;
    }
    return { case: c, anchor: caseAnchor(runId, c.project, c.title), known: streak > 1, streak, lastPassed };
  });
}

export type Resolution = { runId: string; at: string };

/**
 * この実行で NG だったものが、そのあとの実行で OK になっていないかを探す。
 *
 * 全体実行では落ちたが個別に流すと通る、というのはよくある。
 * 元の NG を消さずに「その後 OK になった」を併記して、判断できるようにする。
 */
function findResolutions(root: string, runId: string, cases: CaseRecord[]): Map<string, Resolution> {
  const isFail = (s: string) => s !== 'passed' && s !== 'skipped';
  const out = new Map<string, Resolution>();
  const failed = cases.filter((c) => isFail(c.status));
  if (!failed.length) return out;

  // この実行より後のものを古い順に見て、最後の結果を採る
  const later = listRuns(root)
    .filter((r) => r.id > runId)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const c of failed) {
    for (const r of later) {
      const after = (r.meta.cases ?? []).find((x) => x.project === c.project && x.title === c.title);
      if (!after || after.status === 'skipped') continue;
      if (after.status === 'passed') {
        out.set(caseAnchor(runId, c.project, c.title), { runId: r.id, at: r.meta.startedAt });
      } else {
        out.delete(caseAnchor(runId, c.project, c.title));
      }
    }
  }
  return out;
}

/** 失敗を先頭に出す。リリース判断で最初に見るところ。 */
function renderFailures(runId: string, failures: Failure[], resolved: Map<string, Resolution>): string {
  if (!failures.length) return '';
  const items = failures
    .map((f) => {
      const fix = resolved.get(f.anchor);
      const label = f.known
        ? `<span class="muted">既知（${f.streak} 回連続で失敗${f.lastPassed ? `。最後に通ったのは ${escapeHtml(f.lastPassed)}` : '。通った記録なし'}）</span>`
        : `<span class="ng">新規${f.lastPassed ? `（${escapeHtml(f.lastPassed)} では通っていた）` : ''}</span>`;
      const step = f.case.steps.find((s) => s.error);
      const fixed = fix
        ? `<div class="ok">その後 ${escapeHtml(fix.runId)} の実行では OK になっている</div>`
        : '';
      return `<li><a href="#${f.anchor}">${escapeHtml(f.case.title.split(' › ').at(-1) ?? '')}</a> ${
        fix ? '<span class="ok">再実行で OK</span> ' : ''
      }${label}
      <div class="muted">${escapeHtml(subject(f.case))}</div>
      ${step ? `<div class="muted">落ちた手順: ${escapeHtml(step.title)}</div>` : ''}
      ${f.case.error ? `<div class="ng">${escapeHtml(f.case.error.split('\n')[0] ?? '')}</div>` : ''}${fixed}</li>`;
    })
    .join('');
  const fresh = failures.filter((f) => !f.known).length;
  const fixed = failures.filter((f) => resolved.has(f.anchor)).length;
  return `<div class="issues">
<h2 style="margin-top:0">NG（${failures.length} 件 / 新規 ${fresh}${fixed ? ` / 再実行で OK ${fixed}` : ''}）</h2>
<p class="lede">「新規」は今回から落ちたもの。「既知」は前から落ち続けているもの。
${fixed ? '「再実行で OK」は、この実行のあとに個別に流し直して通ったもの。' : ''}</p>
<ul class="plain">${items}</ul>
</div>`;
}

/** 結果が緑でも人に見てほしいこと（要確認）を先頭にまとめる。 */
function renderIssues(runId: string, cases: CaseRecord[]): string {
  const rows = cases
    .flatMap((c) =>
      annotationsOf(c, ISSUE).map((text) => ({
        text,
        title: c.title,
        project: c.project,
        status: c.status,
        anchor: caseAnchor(runId, c.project, c.title),
      })),
    )
    // 同じ内容がロールごとに並ぶので、文面ごとにまとめる
    .reduce<Map<string, { text: string; where: string[]; anchor: string }>>((acc, r) => {
      const e = acc.get(r.text) ?? { text: r.text, where: [], anchor: r.anchor };
      e.where.push(`${r.title.split(' › ').at(-1)}（${r.project}／${r.title.split(' › ')[0]}）`);
      acc.set(r.text, e);
      return acc;
    }, new Map());

  // fixme で止めているテストも「確認できていない」ものとしてここに出す
  const blocked = new Map<string, string[]>();
  for (const c of cases) {
    for (const a of c.annotations ?? []) {
      if (!a.startsWith('fixme')) continue;
      const key = c.title.split(' › ').at(-1) ?? c.title;
      blocked.set(key, [...(blocked.get(key) ?? []), c.project]);
    }
  }

  if (!rows.size && !blocked.size) return '';
  const items = [...rows.values()]
    .map(
      (r) =>
        `<li><a href="#${r.anchor}">${escapeHtml(r.text)}</a><div class="muted">${escapeHtml(r.where.join(' / '))}</div></li>`,
    )
    .join('');
  const blockedItems = [...blocked.entries()]
    .map(
      ([title, projects]) =>
        `<li>${escapeHtml(title)}<div class="muted">実行を止めている（fixme）: ${escapeHtml([...new Set(projects)].join(', '))}</div></li>`,
    )
    .join('');

  return `<div class="issues">
<h2 style="margin-top:0">要確認（${rows.size + blocked.size} 件）</h2>
<p class="lede">テストは通っているが人に見てほしいもの、および実行を止めているもの。</p>
<ul class="plain">${items}${blockedItems}</ul>
</div>`;
}

/* -------------------------------------------------------------- テスト前提 */

function renderPreconditions(meta: RunMeta, cases: CaseRecord[]): string {
  const rows: Array<[string, string]> = [
    ['対象環境', `${escapeHtml(meta.environment?.name ?? '')} ${escapeHtml(meta.environment?.baseURL ?? '')}`],
    ['実行日時', `${escapeHtml(formatDate(meta.startedAt))} 〜 ${escapeHtml(formatDate(meta.endedAt))}（${formatDuration(meta.durationMs)}）`],
    ['実行対象', escapeHtml((meta.tool?.projects ?? []).join(' / ') || '-')],
    ['ツール', escapeHtml(`Playwright ${meta.tool?.playwright ?? '-'} / 並列 ${meta.tool?.workers ?? '-'}`)],
  ];
  if (meta.report?.purpose) rows.splice(0, 0, ['目的', escapeHtml(meta.report.purpose)]);
  if (meta.report?.scope?.length) rows.push(['範囲', list(meta.report.scope)]);
  if (meta.report?.preconditions?.length) rows.push(['前提条件', list(meta.report.preconditions)]);

  // ケース側で宣言された前提もまとめて載せる（重複は畳む）
  const perCase = new Map<string, Set<string>>();
  for (const c of cases) {
    for (const text of annotationsOf(c, PRECONDITION)) {
      const set = perCase.get(text) ?? new Set<string>();
      set.add(c.project);
      perCase.set(text, set);
    }
  }
  if (perCase.size) {
    rows.push([
      'ケースごとの前提',
      list([...perCase.entries()].map(([text, projects]) => `${text}（${[...projects].join(', ')}）`)),
    ]);
  }

  return `<table class="kv">${rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join('')}</table>`;
}

function list(items: string[]): string {
  return `<ul class="plain">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

/* -------------------------------------------------------------- テスト観点 */

function renderViewpoints(cases: CaseRecord[]): string {
  const groups = new Map<string, { cases: CaseRecord[]; declared: boolean }>();
  for (const c of cases) {
    const declared = declaredViewpointsOf(c).length > 0;
    for (const p of viewpointsOf(c)) {
      const g = groups.get(p) ?? { cases: [], declared };
      g.cases.push(c);
      g.declared = g.declared || declared;
      groups.set(p, g);
    }
  }
  if (!groups.size) return '<p class="lede">ケースがありません</p>';

  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'ja'))
    .map(([point, g]) => {
      const passed = g.cases.filter((c) => c.status === 'passed').length;
      const failed = g.cases.filter((c) => c.status === 'failed' || c.status === 'timedOut').length;
      const skipped = g.cases.filter((c) => c.status === 'skipped').length;
      return `<tr>
      <td>${escapeHtml(point)}${g.declared ? '' : ' <span class="muted">(describe 名)</span>'}</td>
      <td class="n">${g.cases.length}</td>
      <td class="n">${passed}</td>
      <td class="n ${failed ? 'ng' : 'muted'}">${failed}</td>
      <td class="n muted">${skipped}</td>
    </tr>`;
    })
    .join('\n');

  const hasFallback = [...groups.values()].some((g) => !g.declared);
  const hint = hasFallback
    ? '<p class="lede">(describe 名) と付いた行は、テスト側で観点を宣言していないため describe の名前でまとめています。' +
      'そのテストで確かめたいことを明示するなら <code>viewpoint(testInfo, &#39;...&#39;)</code> を呼びます。</p>'
    : '';
  return `<table><tr><th>観点</th><th class="n">ケース</th><th class="n">OK</th><th class="n">NG</th><th class="n">ブロック</th></tr>
${rows}</table>${hint}`;
}

/**
 * 観点ごとのマトリクス。
 *
 * テストが軸を宣言していれば（`details({ 軸: { 対象: 'フォルダ' } })`）、
 * その観点に合った表（対象 × 操作 など）も一緒に出す。
 */
function renderMatrices(runId: string, matrix: Matrix, cases: CaseRecord[]): string {
  const byViewpoint = new Map<string, CaseRecord[]>();
  for (const c of cases) {
    for (const v of viewpointsOf(c)) byViewpoint.set(v, [...(byViewpoint.get(v) ?? []), c]);
  }

  return groupByViewpoint(matrix)
    .map(({ viewpoint, rows }, i) => {
      const axis = buildAxisMatrix(runId, byViewpoint.get(viewpoint) ?? []);
      const extra = axis
        ? `<p class="where">${escapeHtml(axis.rowAxis)} × ${escapeHtml(axis.colAxis)}（テストが宣言した軸。· は未実施）</p>${renderAxisMatrixHtml(axis, { link: true })}`
        : '';
      return `<div class="matrix page">
<h3>3.${i + 1} 観点: ${escapeHtml(viewpoint)} <span class="muted">（${rows.length} ケース）</span></h3>
${extra}
${renderMatrixTable(matrix.columns, rows, { link: true })}
</div>`;
    })
    .join('\n') + `<p class="lede">✅ OK　❌ NG　⏱ タイムアウト　– ブロック（実行できず。理由は詳細に）　· 対象外　／ 記号をクリックするとそのケースの詳細へ飛びます</p>`;
}

/* ------------------------------------------------------ ケースごとの詳細 */

type RenderState = { images: boolean; maxPerCase: number; budget: { left: number; skipped: number } };

/**
 * マトリクスのセル 1 つ = ケース × ロール に対して
 * 「お題・内容・前提・結果・スクリーンショット・操作前後の状態」を並べる。
 */
function renderDetails(
  runId: string,
  dir: string,
  matrix: Matrix,
  cases: CaseRecord[],
  state: RenderState,
  resolved: Map<string, Resolution>,
  attempts: Map<string, Array<{ runId: string; status: string }>>,
  dirOf: (anchor: string) => string,
): string {
  const byAnchor = new Map(cases.map((c) => [caseAnchor(runId, c.project, c.title), c]));
  const groups = groupByViewpoint(matrix);
  if (!groups.length) return '<p class="lede">ケースがありません</p>';

  // 画像の枠は限りがあるので、失敗したケースから先に確保する
  const shots = new Map<string, string>();
  if (state.images) {
    const weight = (c: CaseRecord) => (c.status === 'passed' || c.status === 'skipped' ? 1 : 0);
    for (const [anchor, c] of [...byAnchor.entries()].sort((a, b) => weight(a[1]) - weight(b[1]))) {
      const attachments = (c.attachments ?? []).map((a) =>
        typeof a === 'string' ? { name: a, contentType: '' } : a,
      );
      const html = renderShots(anchor, dirOf(anchor), attachments, state);
      if (html) shots.set(anchor, html);
    }
  }

  return groups
    .map(({ viewpoint, rows }, gi) => {
      let n = 0;
      const blocks = rows
        .flatMap((row) =>
          matrix.columns.flatMap((column) => {
            const cell = row.cells[column];
            if (!cell?.id) return [];
            const c = byAnchor.get(cell.id);
            return c
              ? [
                  renderCase(
                    `4.${gi + 1}.${++n}`,
                    cell.id,
                    column,
                    dirOf(cell.id),
                    c,
                    shots.get(cell.id) ?? '',
                    cases,
                    resolved.get(cell.id),
                    attempts.get(cell.id),
                  ),
                ]
              : [];
          }),
        )
        .join('\n');
      return `<h3>4.${gi + 1} 観点: ${escapeHtml(viewpoint)} <span class="muted">（${n} 件）</span></h3>${blocks}`;
    })
    .join('\n');
}

function renderCase(
  no: string,
  anchor: string,
  column: string,
  dir: string,
  c: CaseRecord,
  shots: string,
  siblings?: CaseRecord[],
  resolution?: Resolution,
  tries?: Array<{ runId: string; status: string }>,
): string {
  const status = STATUS_LABEL[c.status] ?? c.status;
  const cls = c.status === 'passed' ? 'ok' : c.status === 'skipped' ? 'muted' : 'ng';

  const preconditions = annotationsOf(c, PRECONDITION);
  const references = annotationsOf(c, REFERENCE);
  const stepList = c.steps.filter((s) => (s.kind ?? 'step') === 'step');
  const checks = c.steps.filter((s) => s.kind === 'expect');

  const steps = stepList.length
    ? `<ol class="steps">${stepList
        .map(
          (s) =>
            `<li>${escapeHtml(s.title)} <span class="muted">${formatDuration(s.durationMs)}</span>${
              s.error ? ` <span class="ng">${escapeHtml(s.error)}</span>` : ''
            }</li>`,
        )
        .join('')}</ol>`
    : '<span class="muted">手順の記録なし（step() で残せます）</span>';

  // 「何をもって OK / NG としたか」。
  // expect.poll は「条件が満たされるまで繰り返す」仕組みで、Playwright は
  // その試行 1 回ずつを判定として記録する。そのまま並べると、成功した poll の
  // 途中の空振りが ✗ に見えてしまうので、まとめ直す。
  const judgementItems = foldChecks(checks);
  const judgement = judgementItems.length
    ? `<ul class="checks">${judgementItems
        .map((j) => {
          const note =
            j.ok && j.retries
              ? ` <span class="muted">（${j.retries + 1} 回目で成立。一覧の反映待ちなどで最初は満たしていなかった）</span>`
              : '';
          return `<li class="${j.ok ? 'ok' : 'ng'}">${j.ok ? '✓' : '✗'} ${escapeHtml(
            describeCheck(j.title),
          )}${note}${j.error ? `<div class="ng">${escapeHtml(j.error)}</div>` : ''}</li>`;
        })
        .join('')}</ul>`
    : '<span class="muted">判定の記録なし（expect にメッセージを書くとここに出ます）</span>';

  const attachments = (c.attachments ?? []).map((a) =>
    typeof a === 'string' ? { name: a, contentType: '' } : a,
  );
  const result =
    `<span class="${cls}">${status}</span> <span class="muted">${formatDuration(c.durationMs)}</span>` +
    (c.error ? `<pre class="ng">${escapeHtml(c.error)}</pre>` : '') +
    renderNotes(dir, attachments);

  const rows: Array<[string, string]> = [
    ['お題', `${escapeHtml(c.title)}<div class="muted">対象: ${escapeHtml(column)}</div>`],
    ['前提', preconditions.length ? list(preconditions) : '<span class="muted">宣言なし</span>'],
    ['内容', steps],
  ];

  if (c.status === 'skipped') {
    // なぜ未実施なのか。理由が無いまま「-」で埋まるのが一番たちが悪い
    const why = (c.annotations ?? [])
      .filter((a) => a.startsWith('skip:') || a.startsWith('fixme'))
      .map((a) => a.replace(/^(skip|fixme):\s*/, '').trim())
      .filter(Boolean);
    const inferred = siblings ? inferSkipReason(c, siblings) : null;
    rows.push([
      '実行できない理由',
      why.length
        ? list(why)
        : inferred
          ? `<span class="ng">${escapeHtml(inferred)}</span>`
          : '<span class="ng">理由が記録されていない（test.skip / test.fixme に理由を書くこと）</span>',
    ]);
  } else {
    rows.push([c.status === 'passed' ? 'OK と判断した根拠' : 'NG と判断した根拠', judgement]);
  }

  if (tries && tries.length > 1) {
    rows.push([
      '実行の記録',
      `<ol class="steps">${tries
        .map(
          (t, i) =>
            `<li>${i + 1} 回目 <span class="${t.status === 'passed' ? 'ok' : t.status === 'skipped' ? 'muted' : 'ng'}">${
              STATUS_LABEL[t.status] ?? t.status
            }</span> <span class="muted">${escapeHtml(t.runId)}</span></li>`,
        )
        .join('')}</ol>`,
    ]);
  }

  if (resolution) {
    rows.push([
      '再実行の結果',
      `<span class="ok">${escapeHtml(resolution.runId)} の実行では OK</span>` +
        '<div class="muted">この回は NG だが、そのあと個別に流し直して通っている</div>',
    ]);
  }

  rows.push(['結果', result]);
  const issues = annotationsOf(c, ISSUE);
  if (issues.length) rows.push(['要確認', `<div class="ng">${list(issues)}</div>`]);
  if (references.length) rows.push(['参照', list(references)]);

  const states = renderStates(dir, attachments);
  if (states) rows.push(['DB の状態', states]);

  if (shots) rows.push(['スクリーンショット', shots]);

  return `<div class="case" id="${anchor}">
  <h4>${no} <span class="${cls}">${status}</span> ${escapeHtml(c.title)}
    <a class="caseid" href="#${anchor}" title="実行が変わっても変わらない ID">${anchor}</a></h4>
  <table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
</div>`;
}


/** 「状態 <名前> 前 / 後」の対を探して差分表にする。 */
function renderStates(dir: string, attachments: Attachment[]): string {
  const pairs = new Map<string, { 前?: unknown; 後?: unknown }>();
  for (const a of attachments) {
    const m = /^状態 (.+) (前|後)$/.exec(a.name);
    if (!m) continue;
    const raw = readText(dir, a);
    if (raw === null) continue;
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* JSON でなければ文字列のまま */
    }
    const entry = pairs.get(m[1]!) ?? {};
    entry[m[2] as '前' | '後'] = parsed;
    pairs.set(m[1]!, entry);
  }
  return [...pairs.entries()]
    .filter(([, v]) => v.前 !== undefined && v.後 !== undefined)
    .map(([name, v]) => renderStateHtml(diffState(name, v.前, v.後)))
    .join('');
}

/** メモ（note で残したテキスト添付）。 */
function renderNotes(dir: string, attachments: Attachment[]): string {
  return attachments
    .filter((a) => !/^状態 .+ (前|後)$/.test(a.name))
    .filter((a) => a.contentType?.startsWith('text/') || a.name?.endsWith('.txt'))
    .map((a) => ({ name: a.name, text: readText(dir, a) }))
    .filter((t): t is { name: string; text: string } => t.text !== null)
    .map(
      (t) =>
        `<details><summary>${escapeHtml(t.name)}</summary><pre>${escapeHtml(t.text)}</pre></details>`,
    )
    .join('');
}

function readText(dir: string, a: Attachment): string | null {
  if (a.body !== undefined) return a.body;
  if (!a.path) return null;
  const file = path.isAbsolute(a.path) ? a.path : path.join(dir, a.path);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf-8').slice(0, 32 * 1024);
  } catch {
    return null;
  }
}

function renderShots(anchor: string, dir: string, attachments: Attachment[], state: RenderState): string {
  const figures: string[] = [];
  let n = 0;
  for (const a of attachments) {
    if (figures.length >= state.maxPerCase) break;
    if (!a.path || !/^image\//.test(a.contentType || '')) continue;
    const file = path.isAbsolute(a.path) ? a.path : path.join(dir, a.path);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > state.budget.left) {
      state.budget.skipped++;
      continue;
    }
    state.budget.left -= size;
    const type = a.contentType || 'image/png';
    const data = fs.readFileSync(file).toString('base64');
    // data URI は 1 回だけ持つ（同じ画像を 2 か所に書くとファイルが倍になる）。
    // クリックで拡大はチェックボックスで行う（JS 不要）。
    const id = `${anchor}s${++n}`;
    figures.push(
      `<figure><input type="checkbox" id="${id}"><label for="${id}" title="クリックで拡大"><img src="data:${type};base64,${data}" alt="${escapeHtml(a.name)}" loading="lazy"></label><figcaption>${escapeHtml(a.name)}</figcaption></figure>`,
    );
  }
  return figures.length ? `<div class="shots">${figures.join('')}</div>` : '';
}

/**
 * 判定の題を日本語で読めるようにする。
 *
 * expect にメッセージを書いていればそれがそのまま題になる（いちばん良い）。
 * 書いていないときは Playwright が `Expect "toBeVisible" locator(...)` のような題を付けるので、
 * 何を確かめたのかが分かる程度に直す。
 */
const MATCHER: Record<string, string> = {
  toBeVisible: '表示されている',
  toBeHidden: '表示されていない',
  toBeEnabled: '操作できる',
  toBeDisabled: '操作できない',
  toBeChecked: 'チェックが入っている',
  toHaveCount: '件数が期待どおり',
  toHaveText: '文言が一致する',
  toContainText: '文言を含む',
  toHaveValue: '値が一致する',
  toHaveAttribute: '属性が期待どおり',
  toHaveURL: 'URL が期待どおり',
  toHaveTitle: 'タイトルが期待どおり',
  toEqual: '値が期待どおり',
  toBe: '値が期待どおり',
  toMatch: '文言が期待どおり',
  toBeTruthy: '値がある',
  toContain: '含んでいる',
};

export function describeCheck(title: string): string {
  const m = /^Expect "([^"]+)"\s*(.*)$/.exec(title);
  if (!m) return title;
  const [, matcher, target] = m;
  const label = MATCHER[matcher ?? ''] ?? matcher ?? '';
  return target ? `${label}: ${target}` : label;
}

/**
 * 判定の並びを人が読める形に畳む。
 *
 * - poll の親（`poll toContain` のような題）は、中の判定が同じことを言うので落とす
 * - 同じ題が続くのは繰り返しなので 1 行にまとめ、最後の結果を採る
 * - 途中で空振りしていたら「何回目で成立したか」を添える（失敗ではない）
 */
export function foldChecks(
  checks: CaseStep[],
): Array<{ title: string; ok: boolean; retries: number; error?: string }> {
  // 子を持つ親（poll など）は落とす。子の方が具体的な題を持っている
  const leaves = checks.filter((s, i) => {
    const next = checks[i + 1];
    return !(next && (next.nest ?? 0) > (s.nest ?? 0));
  });

  const out: Array<{ title: string; ok: boolean; retries: number; error?: string }> = [];
  for (const s of leaves) {
    const last = out[out.length - 1];
    if (last && last.title === s.title) {
      // 同じ題の繰り返し。空振りを数えて、最後の結果で上書きする
      if (!last.ok) last.retries++;
      last.ok = !s.error;
      last.error = s.error;
      continue;
    }
    out.push({ title: s.title, ok: !s.error, retries: 0, error: s.error });
  }
  return out;
}

/**
 * そのケースが何の話かを 1 行で言う。
 * テスト名だけだと「受信一覧って何の？」になるので、観点と置き場所を添える。
 */
function subject(c: CaseRecord): string {
  const parts = c.title.split(' › ');
  const where = parts.slice(0, -1).join(' › ');
  const viewpoint = viewpointsOf(c)[0];
  return [viewpoint, `${c.project}／${where}`].filter(Boolean).join(' ／ ');
}

/* ------------------------------------------------------------------ 小物 */

function annotationsOf(c: CaseRecord, type: string): string[] {
  return (c.annotations ?? [])
    .filter((a) => a.startsWith(`${type}: `))
    .map((a) => a.slice(type.length + 2).trim())
    .filter(Boolean);
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP');
}

const PRINT_STYLE = `
 .kv th{width:140px;text-align:left;border-bottom:0;border-top:1px solid var(--line);padding:9px 12px 9px 0;font-size:12px;color:var(--muted);vertical-align:top}
 ul.plain{margin:0;padding-left:18px}
 .chips{margin:0 0 6px} .chip{display:inline-block;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:1px 9px;margin:0 6px 4px 0}
 .case h4{font-size:14px;margin:0 0 6px;font-weight:600}
 .issues{border:1px solid var(--ng);border-radius:8px;padding:14px 18px;margin:0 0 24px}
 .issues li{margin-bottom:6px}
 .state{margin:10px 0} .state h4{font-size:12px;color:var(--muted);margin:0 0 4px;font-weight:500}
 .state table{font-size:12px} .state td{padding:5px 8px 5px 0}
 @media print{
   body{background:#fff}
   .wrap{max-width:none;margin:0;padding:0}
   .case,.matrix,.state{break-inside:avoid}
   h2{break-before:page} h2:first-of-type{break-before:auto}
   details{display:none}
   a{color:inherit;text-decoration:none}
 }
`;
