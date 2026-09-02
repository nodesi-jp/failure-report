import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { availableAxes, buildMatrix, pivot, renderAxisMatrixText, renderMatrixText } from './matrix';
import { buildReport, describeCheck, foldChecks } from './report';
import { MCP_INSTRUCTIONS, STATUS_LABEL, exampleSpec, formatPageSpec } from './page';
import { classificationOf } from './matrix';
import { formatGaps, formatStaleSkips } from './lint';
import { formatCatalog, listTests } from './catalog';
import { formatDuration, listRuns, resolveRun, type CaseRecord, type RunEntry } from './site';

/**
 * Failure Report を読むための MCP サーバ（stdio / JSON-RPC、依存なし）。
 *
 *   claude mcp add failure-report -- npx failure-report mcp
 */

type Req = { jsonrpc: '2.0'; id?: number | string; method: string; params?: any };

const NAME = 'failure-report';
const VERSION = '0.2.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'list_runs',
    description:
      '自動テストの実行履歴を新しい順に返す（実行ID・環境・OK/NG/ブロック数・所要時間・転送量）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返す件数。既定 10' },
      },
    },
  },
  {
    name: 'get_run',
    description:
      '実行 1 件の中身を、ケースごとに報告書のページと同じ項目（お題・前提・内容・判断根拠 / 実行できない理由・結果・要確認・DB の状態・スクリーンショット）で返す。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '実行 ID。省略すると最新' },
        status: {
          type: 'string',
          description: 'この状態のケースだけに絞る（passed=OK / failed=NG / skipped=ブロック）',
        },
      },
    },
  },
  {
    name: 'get_matrix',
    description:
      'マトリクスをテキストで返す。既定は「テストケース × ロール」を観点ごとに区切ったもの。row / column を渡すと好きな軸で組み替えられる（例: row=対象, column=共有先）。viewpoint でひとつの観点だけに絞れる。使える軸は axes で確認できる。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '実行 ID。省略すると最新' },
        allEnvironments: { type: 'boolean', description: '環境ごとの最新実行を並べる' },
        viewpoint: { type: 'string', description: 'この観点のケースだけに絞る（部分一致）' },
        row: { type: 'string', description: '行にする軸。テストが宣言した軸か、ロール / 観点 / ファイル / ケース' },
        column: { type: 'string', description: '列にする軸。同上' },
      },
    },
  },
  {
    name: 'list_axes',
    description: 'マトリクスの軸に使える名前を返す（テストが宣言した軸と、常に使える軸）。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: '実行 ID。省略すると最新' } },
    },
  },
  {
    name: 'get_failures',
    description: '直近の実行から NG のケースだけを取り出し、落ちた手順・成立しなかった判定・エラーを返す。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '実行 ID。省略すると最新' },
      },
    },
  },
  {
    name: 'list_tests',
    description:
      'どんなテストがあり、何を確かめることになっているか（観点・前提）を、テストを実行せずに観点ごとに並べて返す。「この観点のテストはあるか」「何をカバーしているか」に答えるときはこれ。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_gaps',
    description:
      '報告書の記述（観点・前提・手順・スクリーンショット）が足りていないテストケースと、何回も続けてブロックされていて一度も実行されていないテストを挙げる。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: '実行 ID。省略すると最新' } },
    },
  },
  {
    name: 'describe_page',
    description:
      'Failure Report のページ（マトリクスの 1 マス = ケース × 対象）に載せる項目の一覧と、その意味・テストのどこから来るか、結果の言葉（OK / NG / ブロック / 対象外）の定義を返す。「各ページに何が要るか」「この項目は何か」「テストをどう書けば埋まるか」に答えるときはこれ。'
    ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_example',
    description:
      'お手本の spec（TypeScript）を丸ごと返す。報告書のページの全欄（お題・前提・内容・判断根拠・結果・要確認・参照・DB の状態・スクリーンショット）が埋まる 1 本と、ブロック（理由付きの test.skip）の正しい形。テストを書き足す前に読んで、この形を真似る。'
    ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'build_share',
    description:
      '実行 1 件を 1 ファイル（スクリーンショット埋め込み HTML）にまとめ、そのパスを返す。人へ渡す用。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '実行 ID。省略すると最新' },
        images: { type: 'boolean', description: '画像を埋め込む。既定 true' },
      },
    },
  },
] as const;

export function runMcpServer(root: string) {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: Req['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Req['id'], code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  const text = (body: string) => ({ content: [{ type: 'text', text: body }] });

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let req: Req;
    try {
      req = JSON.parse(line);
    } catch {
      return fail(undefined, -32700, 'パースできませんでした');
    }

    try {
      switch (req.method) {
        case 'initialize':
          return reply(req.id, {
            protocolVersion: req.params?.protocolVersion ?? DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: NAME, version: VERSION },
            // Claude Code はこれを "MCP Server Instructions" としてプロンプトに載せる
            instructions: MCP_INSTRUCTIONS,
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          return reply(req.id, {});
        case 'tools/list':
          return reply(req.id, { tools: TOOLS });
        case 'tools/call':
          return reply(req.id, text(callTool(root, req.params?.name, req.params?.arguments ?? {})));
        default:
          if (req.id === undefined) return;
          return fail(req.id, -32601, `知らないメソッドです: ${req.method}`);
      }
    } catch (e) {
      return reply(req.id, { ...text(`エラー: ${(e as Error).message}`), isError: true });
    }
  });
}

function callTool(root: string, name: string, args: any): string {
  switch (name) {
    case 'list_runs':
      return describeRuns(listRuns(root).slice(0, Number(args.limit ?? 10)), root);
    case 'get_run':
      return describeRun(resolveRun(root, args.runId), args.status);
    case 'get_matrix': {
      const runs = args.allEnvironments ? latestPerEnvironment(root) : [resolveRun(root, args.runId)];
      const head = runs.map((r) => `${r.meta.environment?.name ?? '?'}  ${r.id}`).join('\n');

      const cases = runs.flatMap((r) =>
        (r.meta.cases ?? []).filter((c) =>
          args.viewpoint
            ? (c.annotations ?? []).some(
                (a) => a.startsWith('観点: ') && a.includes(String(args.viewpoint)),
              )
            : true,
        ),
      );
      if (!cases.length) return `${head}\n\n該当するケースがありません`;

      if (args.row || args.column) {
        const m = pivot(runs[0]!.id, cases, String(args.row ?? 'ケース'), String(args.column ?? 'ロール'));
        if (!m) {
          return `${head}\n\nその軸では組めませんでした。使える軸: ${availableAxes(cases).join(' / ')}`;
        }
        return `${head}\n\n${renderAxisMatrixText(m)}`;
      }
      return `${head}\n\n${renderMatrixText(buildMatrix(runs.map((r) => ({ ...r, meta: { ...r.meta, cases } }))))}`;
    }
    case 'list_axes': {
      const run = resolveRun(root, args.runId);
      return `使える軸: ${availableAxes(run.meta.cases ?? []).join(' / ')}
（テストが details({ 軸: { 対象: 'フォルダ' } }) と宣言した軸が増えます）`;
    }
    case 'get_failures':
      return describeRun(resolveRun(root, args.runId), 'failed');
    case 'list_tests':
      return formatCatalog(listTests());
    case 'list_gaps': {
      const gaps = formatGaps(resolveRun(root, args.runId).meta);
      let collected;
      try {
        collected = listTests();
      } catch {
        collected = undefined;
      }
      const stale = formatStaleSkips(listRuns(root).slice(0, 20), 3, collected);
      return stale ? `${gaps}\n\n${stale}` : gaps;
    }
    case 'describe_page':
      return formatPageSpec();
    case 'get_example':
      return exampleSpec() || 'お手本が見つかりません（templates/example.spec.ts）';
    case 'build_share': {
      const out = buildReport(root, args.runId, { images: args.images !== false });
      return `${out}\n(${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB / 1 ファイルで完結)`;
    }
    default:
      throw new Error(`知らないツールです: ${name}`);
  }
}

function describeRuns(runs: RunEntry[], root: string): string {
  if (!runs.length) return `実行がありません: ${root}`;
  return runs
    .map(({ id, meta }) => {
      const c = meta.counts ?? {};
      const failed = (c.failed ?? 0) + (c.timedOut ?? 0);
      return `${id}  環境=${meta.environment?.name ?? '?'}  ${failed ? `NG ${failed}` : '全て OK'}  OK ${c.passed ?? 0} / ブロック ${c.skipped ?? 0}  ${formatDuration(meta.durationMs)}  ↑${meta.transfer?.upload ?? '-'} ↓${meta.transfer?.download ?? '-'}`;
    })
    .join('\n');
}

function describeRun({ id, dir, meta }: RunEntry, status?: string): string {
  const cases = (meta.cases ?? []).filter((c) =>
    !status ? true : status === 'failed' ? c.status !== 'passed' && c.status !== 'skipped' : c.status === status,
  );
  const head = `実行 ${id}  環境 ${meta.environment?.name ?? '?'} (${meta.environment?.baseURL ?? ''})
開始 ${meta.startedAt}  所要 ${formatDuration(meta.durationMs)}
結果 ${JSON.stringify(meta.counts ?? {})}
転送 ↑${meta.transfer?.upload ?? '-'} ↓${meta.transfer?.download ?? '-'}
フォルダ ${dir}`;

  if (!cases.length) return `${head}\n\n該当するケースはありません`;
  return `${head}\n\n` + cases.map((c) => describeCase(dir, c)).join('\n\n');
}

/**
 * 1 ケースを、報告書のページ（マトリクスの 1 マス）と同じ項目の順で書く。
 * 項目の定義は page.ts。人が report.html で見るものと、AI が MCP で読むものを揃える。
 */
function describeCase(dir: string, c: CaseRecord): string {
  const label = STATUS_LABEL[c.status] ?? c.status;
  const ann = (type: string) =>
    (c.annotations ?? [])
      .filter((a) => a.startsWith(`${type}: `))
      .map((a) => a.slice(type.length + 2).trim())
      .filter(Boolean);
  const attachments = (c.attachments ?? []).map((a) =>
    typeof a === 'string' ? { name: a, contentType: '' } : a,
  );
  const lines = [`[${label}] ${c.project} › ${c.title}  ${formatDuration(c.durationMs)}`];
  const row = (name: string, body: string[]) => {
    if (!body.length) return;
    lines.push(`  ${name}:`);
    for (const b of body) lines.push(`    ${b.replace(/\n/g, '\n    ')}`);
  };

  const group = classificationOf(c);
  row('お題', [
    `${c.title.split(' › ').at(-1) ?? c.title}（対象: ${c.project}${group.length ? ` / 分類: ${group.join(' > ')}` : ''}）`,
  ]);
  row('前提', ann('前提'));

  const steps = c.steps.filter((s) => (s.kind ?? 'step') === 'step');
  row(
    '内容',
    steps.length
      ? steps.map((s) => `- ${s.title} (${formatDuration(s.durationMs)})${s.error ? `  ← ${s.error}` : ''}`)
      : ['（手順の記録なし。step() で残す）'],
  );

  if (c.status === 'skipped') {
    const why = (c.annotations ?? [])
      .filter((a) => a.startsWith('skip:') || a.startsWith('fixme'))
      .map((a) => a.replace(/^(skip|fixme):\s*/, '').trim())
      .filter(Boolean);
    row('実行できない理由', why.length ? why : ['（理由が記録されていない。test.skip / test.fixme に理由を書く）']);
  } else {
    const checks = foldChecks(c.steps.filter((s) => s.kind === 'expect'));
    row(
      c.status === 'passed' ? 'OK と判断した根拠' : 'NG と判断した根拠',
      checks.length
        ? checks.map(
            (j) =>
              `${j.ok ? '✓' : '✗'} ${describeCheck(j.title)}${
                j.ok && j.retries ? `（${j.retries + 1} 回目で成立）` : ''
              }${j.error ? `\n  ${j.error}` : ''}`,
          )
        : ['（判定の記録なし。expect にメッセージを書く）'],
    );
  }

  const notes = attachments
    .filter((a) => !!a.body && !/^状態 /.test(a.name))
    .map((a) => `${a.name}: ${a.body!.slice(0, 500)}`);
  row('結果', [label, ...(c.error ? [`エラー: ${c.error}`] : []), ...notes]);
  row('要確認', ann('要確認'));
  row('参照', ann('参照'));

  const states = attachments.filter((a) => /^状態 .+ (前|後)$/.test(a.name)).map((a) => a.name);
  row('DB の状態', states.length ? [`${states.join(' / ')}（差分は report.html）`] : []);

  const shots = attachments
    .filter((a) => !!a.path && /^image\//.test(a.contentType ?? ''))
    .map((a) => `${a.name}: ${path.isAbsolute(a.path!) ? a.path : path.join(dir, a.path!)}`);
  row('スクリーンショット', shots);
  return lines.join('\n');
}

function latestPerEnvironment(root: string): RunEntry[] {
  const seen = new Set<string>();
  return listRuns(root).filter((r) => {
    const env = r.meta.environment?.name ?? '?';
    if (seen.has(env)) return false;
    seen.add(env);
    return true;
  });
}
