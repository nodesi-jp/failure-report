import crypto from 'node:crypto';
import { escapeHtml, type CaseRecord, type RunEntry } from './site';

export type CellStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'none';

export type Cell = {
  status: CellStatus;
  /** 詳細（テスト内容・前提・結果・スクショ・状態）への参照 */
  id?: string;
};

export type MatrixRow = {
  title: string;
  /** このケースが確かめている観点。宣言が無ければ空。 */
  viewpoints: string[];
  cells: Record<string, Cell>;
};

export type Matrix = {
  /** 列（ロール / プロジェクト。環境をまたぐ場合は「環境 / ロール」） */
  columns: string[];
  rows: MatrixRow[];
  /** 列ごとの集計 */
  totals: Record<string, Record<CellStatus, number>>;
};

export const NO_VIEWPOINT = '（観点の宣言なし）';

const MARK: Record<CellStatus, string> = {
  passed: '✅',
  failed: '❌',
  timedOut: '⏱',
  skipped: '–',
  interrupted: '⚠',
  none: '·',
};

const RANK: CellStatus[] = ['failed', 'timedOut', 'interrupted', 'passed', 'skipped', 'none'];

/**
 * ケースの ID。マトリクスのセルと詳細を結び、報告書のリンク先にもなる。
 *
 * 実行 ID を混ぜない。混ぜると実行のたびに変わってしまい、
 * 「4.8.7 のあれ」と番号で話しても次の実行では別物を指す。
 * ロールとテスト名だけで決まるので、実行をまたいで同じ ID になる。
 */
export function caseAnchor(_runId: string, project: string, title: string): string {
  return 'c' + crypto.createHash('sha1').update(`${project}|${title}`).digest('hex').slice(0, 8);
}

/** ケースが宣言している観点。 */
export function declaredViewpointsOf(c: CaseRecord): string[] {
  return (c.annotations ?? [])
    .filter((a) => a.startsWith('観点: '))
    .map((a) => a.slice(4).trim())
    .filter(Boolean);
}

/**
 * 報告書のまとまりに使う観点。
 *
 * viewpoint() で宣言していれば それ。宣言が無ければ describe の名前を代わりに使う
 * （「ファイル操作」「API を直接叩いたときのガード」など、既に意味のある単位になっているため）。
 * describe も無ければファイル名。
 */
export function viewpointsOf(c: CaseRecord): string[] {
  const declared = declaredViewpointsOf(c);
  if (declared.length) return declared;
  const parts = c.title.split(' › ');
  const middle = parts.slice(1, -1).join(' › ');
  return [middle || parts[0] || NO_VIEWPOINT];
}

/**
 * テスト観点 → テストケース × ロール（環境）のマトリクスを組む。
 *
 * セル 1 つが「そのロールでそのケースを流した結果」であり、
 * 報告書ではセルから詳細（内容・前提・結果・スクショ・操作前後の状態）へ飛べる。
 * 実行を複数渡すと列が「環境 / ロール」になる。
 */
export function buildMatrix(runs: RunEntry[]): Matrix {
  const multiEnv = new Set(runs.map((r) => r.meta.environment?.name ?? '')).size > 1;
  const columns: string[] = [];
  const rows = new Map<string, MatrixRow>();

  for (const { id, meta } of runs) {
    for (const c of meta.cases ?? []) {
      const column = multiEnv ? `${meta.environment?.name ?? '?'} / ${c.project}` : c.project;
      if (!columns.includes(column)) columns.push(column);

      const row = rows.get(c.title) ?? { title: c.title, viewpoints: [], cells: {} };
      for (const v of viewpointsOf(c)) if (!row.viewpoints.includes(v)) row.viewpoints.push(v);

      const current = row.cells[column]?.status;
      const next = c.status as CellStatus;
      // 同じ枠に複数結果（リトライ・分割）が来たら、重い方を残す
      const status = current && RANK.indexOf(current) < RANK.indexOf(next) ? current : next;
      row.cells[column] = { status, id: caseAnchor(id, c.project, c.title) };
      rows.set(c.title, row);
    }
  }

  const list = [...rows.values()].sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  const totals: Matrix['totals'] = {};
  for (const column of columns) {
    const t = { passed: 0, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, none: 0 };
    for (const row of list) t[row.cells[column]?.status ?? 'none']++;
    totals[column] = t;
  }
  return { columns, rows: list, totals };
}

/** 観点ごとに行をまとめる（観点が複数あるケースは両方に出る）。 */
export function groupByViewpoint(matrix: Matrix): Array<{ viewpoint: string; rows: MatrixRow[] }> {
  const groups = new Map<string, MatrixRow[]>();
  for (const row of matrix.rows) {
    for (const v of row.viewpoints.length ? row.viewpoints : [NO_VIEWPOINT]) {
      groups.set(v, [...(groups.get(v) ?? []), row]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === NO_VIEWPOINT ? 1 : b === NO_VIEWPOINT ? -1 : a.localeCompare(b, 'ja')))
    .map(([viewpoint, rows]) => ({ viewpoint, rows }));
}

/* ------------------------------------------------------------ 端末に出す */

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[　-ヿ一-鿿！-｠]/.test(ch) ? 2 : 1;
  return w;
}

export function renderMatrixText(matrix: Matrix): string {
  const titleWidth = Math.min(60, Math.max(10, ...matrix.rows.map((r) => width(r.title))));
  // 長い名前は真ん中を省く（先頭のファイル名と末尾の「何を確かめたか」を残す）
  const clip = (s: string) => {
    if (width(s) <= titleWidth) return s + ' '.repeat(titleWidth - width(s));
    const chars = [...s];
    const head: string[] = [];
    const tail: string[] = [];
    let used = 1;
    let i = 0;
    let j = chars.length - 1;
    while (i <= j) {
      const toHead = used + width(head.join('')) <= titleWidth / 2;
      const ch = toHead ? chars[i++]! : chars[j--]!;
      if (used + width(ch) > titleWidth) break;
      used += width(ch);
      if (toHead) head.push(ch);
      else tail.unshift(ch);
    }
    const out = head.join('') + '…' + tail.join('');
    return out + ' '.repeat(Math.max(0, titleWidth - width(out)));
  };
  const colWidth = matrix.columns.map((c) => Math.max(4, width(c)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)));
  const lines: string[] = [
    ' '.repeat(titleWidth) + '  ' + matrix.columns.map((c, i) => pad(c, colWidth[i]!)).join('  '),
  ];

  const tally = (rows: MatrixRow[], column: string) => {
    const t = { passed: 0, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, none: 0 };
    for (const row of rows) t[row.cells[column]?.status ?? 'none']++;
    return `${t.passed}/${t.failed + t.timedOut}/${t.skipped}`;
  };

  for (const { viewpoint, rows } of groupByViewpoint(matrix)) {
    lines.push('');
    lines.push(`■ ${viewpoint}`);
    for (const row of rows) {
      lines.push(
        clip(row.title) +
          '  ' +
          matrix.columns.map((c, i) => pad(MARK[row.cells[c]?.status ?? 'none'], colWidth[i]!)).join('  '),
      );
    }
    lines.push(
      pad('  OK/NG/ブロック', titleWidth) +
        '  ' +
        matrix.columns.map((c, i) => pad(tally(rows, c), colWidth[i]!)).join('  '),
    );
  }

  lines.push('');
  lines.push(
    pad('全体 OK / NG / ブロック', titleWidth) +
      '  ' +
      matrix.columns
        .map((c, i) => {
          const t = matrix.totals[c]!;
          return pad(`${t.passed}/${t.failed + t.timedOut}/${t.skipped}`, colWidth[i]!);
        })
        .join('  '),
  );
  lines.push('');
  lines.push('✅ OK   ❌ NG   ⏱ タイムアウト   – ブロック（実行できず）   · 対象外');
  return lines.join('\n');
}

/* ------------------------------------------------------------ 報告書に出す */

export type MatrixHtmlOptions = {
  /** セルから詳細（同じページ内のアンカー）へリンクする。 */
  link?: boolean;
  /** 観点ごとに表を分ける（既定）。false にすると 1 枚にまとめる。 */
  split?: boolean;
  /** 観点ごとの見出しに付ける番号（"3" なら 3.1, 3.2 …）。 */
  numberPrefix?: string;
  /** 見出しから飛ばす先の anchor を作る（観点の連番を受け取る）。 */
  detailAnchor?: (index: number) => string;
};

/** 行名の頭にある共通部分（ファイル › describe）を取り出す。 */
export function commonPrefix(rows: MatrixRow[]): string {
  if (rows.length < 2) return '';
  const parts = rows.map((r) => r.title.split(' › '));
  const first = parts[0]!;
  let i = 0;
  while (i < first.length - 1 && parts.every((p) => p.length > i + 1 && p[i] === first[i])) i++;
  return first.slice(0, i).join(' › ');
}

/** 行の集合ひとつ分の表を書く（合計もその集合で数える）。 */
export function renderMatrixTable(
  columns: string[],
  rows: MatrixRow[],
  options: MatrixHtmlOptions = {},
): string {
  // 同じファイル・同じ describe の繰り返しは行名から落とす（横幅を本題に使う）
  const prefix = commonPrefix(rows);
  const label = (title: string) =>
    prefix && title.startsWith(`${prefix} › `) ? title.slice(prefix.length + 3) : title;

  const head = columns.map((c) => `<th class="n">${escapeHtml(c)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c) => {
          const cell = row.cells[c] ?? { status: 'none' as CellStatus };
          const mark = MARK[cell.status];
          const inner =
            options.link && cell.id && cell.status !== 'none'
              ? `<a href="#${cell.id}" title="詳細へ">${mark}</a>`
              : mark;
          return `<td class="n cell ${cell.status}">${inner}</td>`;
        })
        .join('');
      return `<tr><td>${escapeHtml(label(row.title))}</td>${cells}</tr>`;
    })
    .join('\n');

  const foot = columns
    .map((c) => {
      const t = { passed: 0, failed: 0, timedOut: 0, skipped: 0, interrupted: 0, none: 0 };
      for (const row of rows) t[row.cells[c]?.status ?? 'none']++;
      const ng = t.failed + t.timedOut;
      return `<td class="n muted">${t.passed}<span class="${ng ? 'ng' : 'muted'}"> / ${ng}</span> / ${t.skipped}</td>`;
    })
    .join('');

  return `${prefix ? `<p class="where">${escapeHtml(prefix)}</p>` : ''}<table>
<tr><th>テストケース</th>${head}</tr>
${body}
<tr class="foot"><td class="muted">OK / NG / ブロック</td>${foot}</tr>
</table>`;
}

const LEGEND = '✅ OK　❌ NG　⏱ タイムアウト　– ブロック（実行できず。理由は詳細に）　· 対象外';

export function renderMatrixHtml(matrix: Matrix, options: MatrixHtmlOptions = {}): string {
  if (!matrix.columns.length) return '';
  const split = options.split ?? true;

  if (!split) {
    return `<div class="matrix">
${renderMatrixTable(matrix.columns, matrix.rows, options)}
<p class="lede" style="margin-top:8px">${LEGEND}</p>
</div>`;
  }

  // 観点ごとに 1 枚。印刷すると観点ごとにページが変わる
  const blocks = groupByViewpoint(matrix).map(({ viewpoint, rows }, i) => {
    const no = options.numberPrefix ? `${options.numberPrefix}.${i + 1} ` : '';
    const jump = options.detailAnchor
      ? ` <a class="jump" href="#${options.detailAnchor(i)}">詳細へ</a>`
      : '';
    return `<div class="matrix page">
<h3>${no}観点: ${escapeHtml(viewpoint)} <span class="muted">（${rows.length} ケース）</span>${jump}</h3>
${renderMatrixTable(matrix.columns, rows, options)}
</div>`;
  });

  return `${blocks.join('\n')}
<p class="lede">${LEGEND}${
    options.link ? '　／ 記号をクリックするとそのケースの詳細（内容・前提・結果・スクショ・操作前後の状態）へ飛びます' : ''
  }</p>`;
}

/* ------------------------------------------------ 観点ごとの、軸を変えた表 */

export type AxisMatrix = {
  rowAxis: string;
  colAxis: string;
  rows: string[];
  columns: string[];
  cells: Record<string, Record<string, Cell>>;
};

/** ケースが宣言した軸（`軸: 対象=フォルダ`）を読む。 */
export function axesOf(c: CaseRecord): Array<[string, string]> {
  return (c.annotations ?? [])
    .filter((a) => a.startsWith('軸: '))
    .map((a) => a.slice(3).trim())
    .map((a) => {
      const i = a.indexOf('=');
      return i < 0 ? null : ([a.slice(0, i).trim(), a.slice(i + 1).trim()] as [string, string]);
    })
    .filter((v): v is [string, string] => !!v);
}

/**
 * その観点に合った軸で表を組む。
 *
 * 軸を 1 つだけ宣言していれば「行=その軸 / 列=ロール」、
 * 2 つ以上なら「行=1つ目 / 列=2つ目」。宣言が無ければ null（既定の表を使う）。
 */
export function buildAxisMatrix(runId: string, cases: CaseRecord[]): AxisMatrix | null {
  const declared = cases.filter((c) => axesOf(c).length);
  if (!declared.length) return null;

  const names: string[] = [];
  for (const c of declared) for (const [name] of axesOf(c)) if (!names.includes(name)) names.push(name);

  const rowAxis = names[0]!;
  const colAxis = names[1] ?? 'ロール';
  const rows: string[] = [];
  const columns: string[] = [];
  const cells: Record<string, Record<string, Cell>> = {};

  for (const c of declared) {
    const axes = new Map(axesOf(c));
    const row = axes.get(rowAxis);
    if (!row) continue;
    const column = names[1] ? (axes.get(colAxis) ?? '—') : c.project;
    if (!rows.includes(row)) rows.push(row);
    if (!columns.includes(column)) columns.push(column);

    const current = cells[row]?.[column]?.status;
    const next = c.status as CellStatus;
    const status = current && RANK.indexOf(current) < RANK.indexOf(next) ? current : next;
    cells[row] = { ...(cells[row] ?? {}), [column]: { status, id: caseAnchor(runId, c.project, c.title) } };
  }
  return rows.length ? { rowAxis, colAxis, rows, columns, cells } : null;
}

export function renderAxisMatrixHtml(m: AxisMatrix, options: { link?: boolean } = {}): string {
  const head = m.columns.map((c) => `<th class="n">${escapeHtml(c)}</th>`).join('');
  const body = m.rows
    .map((row) => {
      const cells = m.columns
        .map((col) => {
          const cell = m.cells[row]?.[col] ?? { status: 'none' as CellStatus };
          const mark = MARK[cell.status];
          const inner =
            options.link && cell.id && cell.status !== 'none'
              ? `<a href="#${cell.id}" title="詳細へ">${mark}</a>`
              : mark;
          return `<td class="n cell ${cell.status}">${inner}</td>`;
        })
        .join('');
      return `<tr><td>${escapeHtml(row)}</td>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="matrix"><table>
<tr><th>${escapeHtml(m.rowAxis)} \\ ${escapeHtml(m.colAxis)}</th>${head}</tr>
${body}
</table></div>`;
}

/* -------------------------------------------- 好きな軸で組み替える（集計） */

/**
 * 好きな軸で表を組み替える。
 *
 * 軸に使えるのは、テストが宣言した軸（`軸: 対象=フォルダ`）のほか、
 * 「ロール」「観点」「ファイル」「ケース」。
 * 報告書に固定の形を持たせず、見たい切り口で後から組めるようにするための入口。
 */
export function pivot(
  runId: string,
  cases: CaseRecord[],
  rowAxis: string,
  colAxis: string,
): AxisMatrix | null {
  const value = (c: CaseRecord, axis: string): string | undefined => {
    if (axis === 'ロール' || axis === 'project') return c.project;
    if (axis === '観点') return viewpointsOf(c)[0];
    if (axis === 'ファイル') return c.title.split(' › ')[0];
    if (axis === 'ケース' || axis === 'テスト') return c.title.split(' › ').at(-1);
    return new Map(axesOf(c)).get(axis);
  };

  const rows: string[] = [];
  const columns: string[] = [];
  const cells: Record<string, Record<string, Cell>> = {};

  for (const c of cases) {
    const row = value(c, rowAxis);
    const column = value(c, colAxis);
    if (!row || !column) continue;
    if (!rows.includes(row)) rows.push(row);
    if (!columns.includes(column)) columns.push(column);
    const current = cells[row]?.[column]?.status;
    const next = c.status as CellStatus;
    const status = current && RANK.indexOf(current) < RANK.indexOf(next) ? current : next;
    cells[row] = { ...(cells[row] ?? {}), [column]: { status, id: caseAnchor(runId, c.project, c.title) } };
  }
  return rows.length ? { rowAxis, colAxis, rows, columns, cells } : null;
}

/** 端末で読む用。 */
export function renderAxisMatrixText(m: AxisMatrix): string {
  const w = (s: string) => {
    let n = 0;
    for (const ch of s) n += /[　-ヿ一-鿿！-｠]/.test(ch) ? 2 : 1;
    return n;
  };
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)));
  const rowWidth = Math.max(w(`${m.rowAxis} \\ ${m.colAxis}`), ...m.rows.map(w));
  const colWidth = m.columns.map((c) => Math.max(4, w(c)));
  const lines = [
    pad(`${m.rowAxis} \\ ${m.colAxis}`, rowWidth) + '  ' + m.columns.map((c, i) => pad(c, colWidth[i]!)).join('  '),
  ];
  for (const row of m.rows) {
    lines.push(
      pad(row, rowWidth) +
        '  ' +
        m.columns.map((c, i) => pad(MARK[m.cells[row]?.[c]?.status ?? 'none'], colWidth[i]!)).join('  '),
    );
  }
  lines.push('');
  lines.push('✅ OK   ❌ NG   ⏱ タイムアウト   – ブロック（実行できず）   · 対象外');
  return lines.join('\n');
}

/** どんな軸が使えるか（宣言済みの軸 + 常に使える軸）。 */
export function availableAxes(cases: CaseRecord[]): string[] {
  const declared = new Set<string>();
  for (const c of cases) for (const [name] of axesOf(c)) declared.add(name);
  return [...declared, 'ロール', '観点', 'ファイル', 'ケース'];
}
