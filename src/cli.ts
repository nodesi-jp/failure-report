#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { buildReport } from './report';
import {
  availableAxes,
  buildMatrix,
  pivot,
  renderAxisMatrixHtml,
  renderAxisMatrixText,
  renderMatrixHtml,
  renderMatrixText,
} from './matrix';
import { runMcpServer } from './mcp';
import { findGaps, formatGaps, formatStaleSkips, findStaleSkips } from './lint';
import { formatCatalog, listTests } from './catalog';
import { exampleSpec, formatPageSpec } from './page';
import { STYLE, escapeHtml, formatDuration, listRuns, resolveRun, writeIndex } from './site';

const PKG = '@nodesi/failure-report';

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) args[key!] = inline;
      else if (next && !next.startsWith('--')) args[key!] = argv[++i]!;
      else args[key!] = true;
    } else if (/^-[A-Za-z]$/.test(a)) {
      // 短い形（-n 5）
      const next = argv[i + 1];
      args[a.slice(1)] = next && !next.startsWith('-') ? argv[++i]! : true;
    } else {
      (args._ as string[]).push(a);
    }
  }
  return args;
}

function evidenceRoot(args: Args): string {
  return path.resolve(
    String(args.dir ?? process.env.EVIDENCE_DIR ?? path.join(process.cwd(), 'evidence')),
  );
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE = `
failure-report — Playwright の実行から Failure Report（テスト報告書）を作る・見る・配る

  npx failure-report <コマンド> [オプション]

コマンド
  init [--write] [--claude] [--example]
                                 このプロジェクトに導入する（設定への追記を表示、--write で書き込む。
                                 --claude で CLAUDE.md に書き方の決めごとを足す。何度流しても
                                 重複せず、節が最新の文面に置き換わる。
                                 --example でお手本 spec を tests/ に写す）
  list [-n <件数>]                実行の一覧を表示する
  serve [--port 4321] [--host]   ブラウザで見る（--host 0.0.0.0 で LAN のチームにも見せられる）
  report [<実行ID>] [--out <file>] Failure Report を 1 ファイルで作る（観点・前提・マトリクス・
                                 手順・スクショ・操作前後の状態、印刷して PDF にもできる）
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
`.trim();

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'list':
    case 'ls':
      return cmdList(args);
    case 'serve':
      return cmdServe(args);
    case 'report':
    case 'share':
      return cmdReport(args);
    case 'matrix':
      return cmdMatrix(args);
    case 'lint':
      return cmdLint(args);
    case 'catalog':
      return void console.log(formatCatalog(listTests()));
    case 'page':
      return void console.log(formatPageSpec());
    case 'practices':
      return void console.log(claudeSection());
    case 'example':
      return void console.log(exampleSpec());
    case 'publish':
      return cmdPublish(args);
    case 'prune':
      return cmdPrune(args);
    case 'index':
      return void console.log(`書き出しました: ${writeIndex(evidenceRoot(args))}`);
    case 'open':
      return cmdOpen(args);
    case 'mcp':
      return runMcpServer(evidenceRoot(args));
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      return void console.log(USAGE);
    default:
      die(`知らないコマンドです: ${command}\n\n${USAGE}`);
  }
}

/* ---------------------------------------------------------------- list */

function cmdList(args: Args) {
  const root = evidenceRoot(args);
  const limit = Number(args.n ?? args.limit ?? 20);
  const runs = listRuns(root).slice(0, limit);
  if (!runs.length) return void console.log(`実行がありません: ${root}`);

  const rows = runs.map(({ id, meta }) => {
    const failed = (meta.counts?.failed ?? 0) + (meta.counts?.timedOut ?? 0);
    return [
      id,
      meta.environment?.name ?? '',
      failed ? `NG ${failed}` : 'OK',
      String(meta.counts?.passed ?? 0),
      String(meta.counts?.skipped ?? 0),
      formatDuration(meta.durationMs),
      `↑${meta.transfer?.upload ?? '-'} ↓${meta.transfer?.download ?? '-'}`,
    ];
  });
  const head = ['実行', '環境', '結果', 'OK', 'ブロック', '所要', '転送量'];
  const width = head.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c + ' '.repeat(width[i]! - displayWidth(c))).join('  ');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  console.log(`\n${root}`);
}

/** 全角を 2 桁として数える（端末で列が揃うように）。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[　-ヿ一-鿿！-｠]/.test(ch) ? 2 : 1;
  return w;
}

/* -------------------------------------------------------------- report */

function cmdReport(args: Args) {
  const root = evidenceRoot(args);
  const runId = (args._ as string[])[0];
  const out = buildReport(root, runId, {
    out: args.out ? path.resolve(String(args.out)) : undefined,
    images: args.images !== 'false' && args['no-images'] !== true,
    maxImagesPerCase: args['max-images'] ? Number(args['max-images']) : undefined,
    maxTotalImageBytes: args['max-mb'] ? Number(args['max-mb']) * 1024 * 1024 : undefined,
  });
  const size = fs.statSync(out).size;
  console.log(`Failure Report: ${out} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log('このファイル 1 つで完結しています。そのまま添付して渡せます（印刷で PDF にもできます）。');
  writeIndex(root);
  if (args.open) openInBrowser(out);
}

/* -------------------------------------------------------------- matrix */

function cmdMatrix(args: Args) {
  const root = evidenceRoot(args);
  const runs = args['all-envs'] === true ? latestPerEnvironment(root) : [resolveRun(root, (args._ as string[])[0])];
  if (!runs.length) die(`実行がありません: ${root}`);
  // 観点で絞る／好きな軸で組み替える
  const viewpoint = args.viewpoint ? String(args.viewpoint) : undefined;
  const picked = runs.map((r) => ({
    ...r,
    meta: {
      ...r.meta,
      cases: (r.meta.cases ?? []).filter((c) =>
        viewpoint
          ? (c.annotations ?? []).some((a) => a.startsWith('観点: ') && a.includes(viewpoint))
          : true,
      ),
    },
  }));
  const cases = picked.flatMap((r) => r.meta.cases ?? []);
  if (!cases.length) die(viewpoint ? `その観点のケースがありません: ${viewpoint}` : 'ケースがありません');

  if (args.row || args.col || args.column) {
    const m = pivot(
      picked[0]!.id,
      cases,
      String(args.row ?? 'ケース'),
      String(args.col ?? args.column ?? 'ロール'),
    );
    if (!m) die(`その軸では組めませんでした。使える軸: ${availableAxes(cases).join(' / ')}`);
    if (args.html === true || args.out) {
      const out = args.out ? path.resolve(String(args.out)) : path.join(picked[0]!.dir, 'matrix.html');
      fs.writeFileSync(out, matrixPage(`${m.rowAxis} × ${m.colAxis}`, renderAxisMatrixHtml(m)));
      console.log(`書き出しました: ${out}`);
      if (args.open) openInBrowser(out);
      return;
    }
    return void console.log(renderAxisMatrixText(m!));
  }

  const matrix = buildMatrix(picked);

  if (args.html === true || args.out) {
    const target = runs.length === 1 ? runs[0]!.dir : root;
    const out = args.out ? path.resolve(String(args.out)) : path.join(target, 'matrix.html');
    const title = runs.map((r) => `${r.meta.environment?.name ?? ''} ${r.id}`).join(' / ');
    fs.writeFileSync(out, matrixPage(title, renderMatrixHtml(matrix)));
    console.log(`書き出しました: ${out}`);
    if (args.open) openInBrowser(out);
    return;
  }

  console.log(picked.map((r) => `${r.meta.environment?.name ?? '?'}  ${r.id}`).join('\n'));
  console.log('');
  console.log(renderMatrixText(matrix));
}

/** 環境ごとに最新の実行を 1 件ずつ拾う。 */
function latestPerEnvironment(root: string) {
  const seen = new Set<string>();
  return listRuns(root).filter((r) => {
    const env = r.meta.environment?.name ?? '?';
    if (seen.has(env)) return false;
    seen.add(env);
    return true;
  });
}

function matrixPage(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>テストマトリクス</title>
<style>${STYLE}</style>
<div class="wrap"><h1>テストマトリクス</h1><p class="lede">${escapeHtml(title)}</p>${body}</div></html>`;
}

/* ---------------------------------------------------------------- lint */

function cmdLint(args: Args) {
  const root = evidenceRoot(args);
  const run = resolveRun(root, (args._ as string[])[0]);
  console.log(formatGaps(run.meta));

  // ずっと実行されていないテストも挙げる（ブロックに埋もれた不具合を拾うため）。
  // いま収集されるものだけを対象にする（収集をやめた組み合わせは「実行されていない」ではない）
  const history = listRuns(root).slice(0, 20);
  const collected = args['no-catalog'] === true ? undefined : catalogSafely();
  const stale = formatStaleSkips(history, 3, collected);
  if (stale) console.log(`\n${stale}`);

  const bad = findGaps(run.meta).length || findStaleSkips(history, 3, collected).length;
  if (args.strict === true && bad) process.exit(1);
}

/** catalog が取れないときは黙って諦める（Playwright が無い場所でも lint は動かす）。 */
function catalogSafely() {
  try {
    return listTests();
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------- serve */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};

function cmdServe(args: Args) {
  const root = evidenceRoot(args);
  if (!fs.existsSync(root)) die(`エビデンスがありません: ${root}`);
  writeIndex(root);

  const port = Number(args.port ?? process.env.PORT ?? 4321);
  const host = String(args.host ?? '127.0.0.1');

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = path.join(root, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!path.resolve(file).startsWith(root)) return send(res, 403, 'forbidden');
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      return send(res, 404, 'not found');
    }
    if (!fs.existsSync(file)) return send(res, 404, 'not found');

    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    // 動画のシークのために Range に応える
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
        });
        return void fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });

  // 既に動いている（前回の serve を閉じていない）ときは、落ちずに場所を教える。
  // --open ならそのまま開く。別のものが使っているなら --port で逃がす。
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    const url = `http://${host === '0.0.0.0' ? localAddress() : host}:${port}/`;
    console.log(`ポート ${port} は既に使われています（前回の serve が動いたままかもしれません）: ${url}`);
    console.log(`  そのまま見るならこの URL を開く。別に立てるなら --port <番号>。止めるなら: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    if (args.open) openInBrowser(url);
    process.exit(0);
  });

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? localAddress() : host;
    const url = `http://${shown}:${port}/`;
    console.log(`エビデンスを配信中: ${url}`);
    console.log(`  ${root}`);
    if (host === '0.0.0.0') console.log('  同じネットワークのチームからも見られます（Ctrl+C で停止）');
    else console.log('  チームに見せるなら --host 0.0.0.0（Ctrl+C で停止）');
    if (args.open) openInBrowser(url);
  });
}

function send(res: http.ServerResponse, code: number, body: string) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function localAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return 'localhost';
}

/* ------------------------------------------------------------- publish */

const HEAVY = /\.(zip|webm|mp4)$/i;

function cmdPublish(args: Args) {
  const root = evidenceRoot(args);
  const to = String(args.to ?? '');
  if (!to) die('置き場所を指定してください: --to <ディレクトリ> | s3://... | gh-pages');

  const which = String(args.runs ?? 'latest');
  const runs =
    which === 'all' ? listRuns(root) : [resolveRun(root, which === 'latest' ? undefined : which)];
  if (!runs.length) die(`公開できる実行がありません: ${root}`);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pwev-site-'));
  const light = args.light === true;
  for (const run of runs) {
    copyDir(run.dir, path.join(stage, run.id), light ? (f) => !HEAVY.test(f) : undefined);
  }
  writeIndex(stage);
  const bytes = dirSize(stage);
  console.log(
    `${runs.length} 件の実行をまとめました（${(bytes / 1024 / 1024).toFixed(1)} MB${light ? ' / トレース・動画は除外' : ''}）`,
  );

  if (to.startsWith('s3://')) publishToS3(stage, to, args);
  else if (to === 'gh-pages') publishToGhPages(stage, args);
  else publishToDir(stage, path.resolve(to), args);

  fs.rmSync(stage, { recursive: true, force: true });
}

function publishToDir(stage: string, dest: string, args: Args) {
  if (args.clean === true && fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyDir(stage, dest);
  console.log(`置きました: ${dest}`);
  console.log(`  ${path.join(dest, 'index.html')} を開けば一覧が見られます`);
}

function publishToS3(stage: string, dest: string, args: Args) {
  if (!hasCommand('aws')) die('AWS CLI が要ります（brew install awscli）');
  const cmd = ['s3', 'sync', stage, dest.replace(/\/$/, '') + '/'];
  if (args.delete === true) cmd.push('--delete');
  console.log(`aws ${cmd.join(' ')}`);
  const r = spawnSync('aws', cmd, { stdio: 'inherit' });
  if (r.status !== 0) die('アップロードに失敗しました');
  console.log(`上げました: ${dest}`);
  console.log('  静的サイトホスティングか CloudFront を有効にすると URL で共有できます');
}

function publishToGhPages(stage: string, args: Args) {
  if (!hasCommand('git')) die('git が要ります');
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8' });
  if (inRepo.status !== 0) die('git リポジトリの中で実行してください');

  const branch = String(args.branch ?? 'gh-pages');
  const remote = String(args.remote ?? 'origin');
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pwev-ghp-'));
  const git = (...a: string[]) => spawnSync('git', a, { stdio: 'inherit' });

  const exists =
    spawnSync('git', ['rev-parse', '--verify', branch], { stdio: 'ignore' }).status === 0;
  const add = exists
    ? git('worktree', 'add', worktree, branch)
    : git('worktree', 'add', '--detach', worktree);
  if (add.status !== 0) die('worktree を作れませんでした');

  try {
    if (!exists) spawnSync('git', ['-C', worktree, 'checkout', '--orphan', branch], { stdio: 'inherit' });
    for (const e of fs.readdirSync(worktree)) {
      if (e !== '.git') fs.rmSync(path.join(worktree, e), { recursive: true, force: true });
    }
    copyDir(stage, worktree);
    fs.writeFileSync(path.join(worktree, '.nojekyll'), '');
    spawnSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'inherit' });
    spawnSync('git', ['-C', worktree, 'commit', '-m', `evidence ${new Date().toISOString()}`], {
      stdio: 'inherit',
    });
    if (args.push === true) {
      const r = spawnSync('git', ['-C', worktree, 'push', remote, branch], { stdio: 'inherit' });
      if (r.status !== 0) die('push に失敗しました');
      console.log(`${remote}/${branch} へ送りました。GitHub Pages を有効にすれば URL で共有できます`);
    } else {
      console.log(`${branch} にコミットしました（送信はまだです）`);
      console.log(`  送るなら: git push ${remote} ${branch}  もしくは --push を付けて実行`);
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
  }
}

/* --------------------------------------------------------------- prune */

function cmdPrune(args: Args) {
  const root = evidenceRoot(args);
  const keep = Number(args.keep ?? 10);
  if (!Number.isFinite(keep) || keep < 1) die('--keep には 1 以上の数を指定してください');

  const runs = listRuns(root);
  const doomed = runs.slice(keep);
  if (!doomed.length) return void console.log(`消すものはありません（${runs.length} 件、--keep ${keep}）`);

  console.log(`消す対象（${doomed.length} 件、新しい ${keep} 件は残す）:`);
  for (const r of doomed) console.log(`  ${r.id}  ${(dirSize(r.dir) / 1024 / 1024).toFixed(1)} MB`);

  if (args.yes !== true) return void console.log('\n実際に消すには --yes を付けてください');
  for (const r of doomed) fs.rmSync(r.dir, { recursive: true, force: true });
  writeIndex(root);
  console.log(`\n${doomed.length} 件消しました`);
}

/* ---------------------------------------------------------------- init */

function cmdInit(args: Args) {
  const config = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js'].find(
    (f) => fs.existsSync(path.join(process.cwd(), f)),
  );
  if (!config) die('playwright.config.ts が見つかりません。Playwright のプロジェクトの中で実行してください');

  const file = path.join(process.cwd(), config);
  const source = fs.readFileSync(file, 'utf-8');
  const missing = {
    import: !source.includes(PKG),
    outputDir: !/outputDir\s*:/.test(source),
    reporter: !source.includes(`${PKG}/reporter`),
    trace: !/trace\s*:/.test(source),
  };

  if (!Object.values(missing).some(Boolean)) {
    console.log(`${config} は設定済みです。`);
    writeClaudeSection(args);
    writeExample(args);
    return void console.log(`\n${nextSteps()}`);
  }

  if (args.write !== true) {
    console.log(`${config} に足すもの:\n`);
    console.log(SNIPPET);
    console.log('\n自動で入れるなら: npx failure-report init --write');
    return;
  }

  let patched = source;
  const notDone: string[] = [];

  if (missing.import) {
    const lastImport = [...source.matchAll(/^import .*$/gm)].at(-1);
    const line = `import { paths } from '${PKG}/runContext';`;
    patched = lastImport
      ? patched.slice(0, lastImport.index! + lastImport[0].length) +
        `\n${line}` +
        patched.slice(lastImport.index! + lastImport[0].length)
      : `${line}\n${patched}`;
  }

  /** defineConfig({ の直後に差し込む。 */
  const insertIntoConfig = (text: string): boolean => {
    const m = /defineConfig(?:<[^>]*>)?\s*\(\s*\{/.exec(patched);
    if (!m) return false;
    const at = m.index + m[0].length;
    patched = patched.slice(0, at) + text + patched.slice(at);
    return true;
  };

  if (missing.outputDir) {
    const ok = insertIntoConfig('\n  // 実行ごとのフォルダへ残す（上書きしない）\n  outputDir: paths.artifacts,');
    if (!ok) notDone.push('outputDir: paths.artifacts');
  }

  if (missing.reporter) {
    const appended = appendReporter(patched);
    if (appended) {
      patched = appended;
    } else {
      const ok = insertIntoConfig(
        `\n  reporter: [\n    ['html', { open: 'never', outputFolder: paths.report }],\n    ['list'],\n    ['${PKG}/reporter'],\n  ],`,
      );
      if (!ok) notDone.push(`reporter: [['${PKG}/reporter']]`);
    }
  }

  if (missing.trace) {
    if (/use\s*:\s*\{/.test(patched)) {
      patched = patched.replace(
        /use\s*:\s*\{/,
        (m) =>
          `${m}\n    // 証拠は常に取る（操作ごとの DOM・ネットワーク・コンソール）\n    trace: 'on',\n    screenshot: 'on',\n    video: 'retain-on-failure',`,
      );
    } else {
      const ok = insertIntoConfig(
        `\n  use: {\n    trace: 'on',\n    screenshot: 'on',\n    video: 'retain-on-failure',\n  },`,
      );
      if (!ok) notDone.push("use: { trace: 'on', screenshot: 'on' }");
    }
  }

  if (notDone.length) {
    console.warn('defineConfig({ ... }) を見つけられませんでした。手で足してください:\n');
    console.log(SNIPPET);
    return;
  }

  fs.writeFileSync(`${file}.bak`, source);
  fs.writeFileSync(file, patched);
  console.log(`${config} を更新しました（元は ${config}.bak）`);
  writeClaudeSection(args);
  writeExample(args);
  console.log(`\n${nextSteps()}`);
}

/**
 * Claude Code が同じ書き方を守れるように、CLAUDE.md に決めごとを足す。
 * （観点・前提・手順の書き方と、確認に使うコマンド）
 */
function writeClaudeSection(args: Args) {
  if (args.claude !== true) {
    console.log(`\nCLAUDE.md に書き方の決めごとを足すなら: npx failure-report init --claude`);
    return;
  }
  const result = upsertClaudeSection(path.join(process.cwd(), 'CLAUDE.md'));
  if (!result) return;
  console.log(
    result === 'added'
      ? 'CLAUDE.md に「Failure Report」の節を足しました'
      : result === 'updated'
        ? 'CLAUDE.md の「Failure Report」の節を最新の文面に置き換えました'
        : 'CLAUDE.md の「Failure Report」の節は最新です',
  );
}

/** お手本 spec を tests/ に写す。既にあれば触らない（手で育てているかもしれない）。 */
function writeExample(args: Args) {
  if (args.example !== true) return;
  const body = exampleSpec();
  if (!body) return;
  // 置き場所は playwright.config の testDir に合わせる（無ければ tests/）
  const config = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js']
    .map((f) => path.join(process.cwd(), f))
    .find((f) => fs.existsSync(f));
  const m = config ? /testDir\s*:\s*['"]\.?\/?([^'"]+)['"]/.exec(fs.readFileSync(config, 'utf-8')) : null;
  const dir = m?.[1] ?? 'tests';
  const target = path.join(process.cwd(), dir, 'failure-report.example.spec.ts');
  if (fs.existsSync(target)) {
    return void console.log(`お手本は既にあります: ${path.relative(process.cwd(), target)}（最新は npx failure-report example）`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  console.log(`お手本 spec を写しました: ${path.relative(process.cwd(), target)}\n  流す: npx playwright test failure-report.example`);
}

const SECTION_BEGIN = '<!-- @nodesi/failure-report:begin（この間は npx failure-report init --claude が書き換える。手で直すなら外に書く） -->';
const SECTION_END = '<!-- @nodesi/failure-report:end -->';

/** テンプレートの節（決めごと）。`failure-report practices` でも出す。 */
function claudeSection(): string {
  const template = path.join(__dirname, '..', 'templates', 'CLAUDE.section.md');
  return fs.existsSync(template) ? fs.readFileSync(template, 'utf-8').trim() : '';
}

/**
 * CLAUDE.md に節を「1 つだけ」持たせる。
 * 印（コメント）で囲っておき、あれば中身を置き換え、無ければ末尾に足す。
 * 何度実行しても増えないので、パッケージを上げたらもう一度流せばよい。
 */
export function upsertClaudeSection(target: string): 'added' | 'updated' | 'unchanged' | null {
  const section = claudeSection();
  if (!section) return null;
  const block = `${SECTION_BEGIN}\n${section}\n${SECTION_END}`;
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';

  const begin = current.indexOf(SECTION_BEGIN);
  const end = current.indexOf(SECTION_END);
  if (begin >= 0 && end > begin) {
    const next = current.slice(0, begin) + block + current.slice(end + SECTION_END.length);
    if (next === current) return 'unchanged';
    fs.writeFileSync(target, next);
    return 'updated';
  }
  fs.writeFileSync(target, `${current.replace(/\s+$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`);
  return 'added';
}

/** すでにある reporter 配列の末尾へ足す（無ければ null）。 */
function appendReporter(source: string): string | null {
  const m = /reporter\s*:\s*\[/.exec(source);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const body = source.slice(m.index, i);
        const entry = `['${PKG}/reporter']`;
        const insert = body.includes('\n') ? `  ${entry},\n  ` : `, ${entry}`;
        return source.slice(0, i) + insert + source.slice(i);
      }
    }
  }
  return null;
}

const SNIPPET = `import { paths } from '${PKG}/runContext';

export default defineConfig({
  outputDir: paths.artifacts,                                  // 実行ごとのフォルダへ
  reporter: [
    ['html', { open: 'never', outputFolder: paths.report }],
    ['list'],
    ['${PKG}/reporter'],                        // エビデンス一式をまとめる
  ],
  use: {
    trace: 'on',            // 操作ごとの DOM・ネットワーク・コンソール
    screenshot: 'on',
    video: 'retain-on-failure',
  },
});`;

function nextSteps(): string {
  return `使いかた:
  テスト中:  import { shot, step, note } from '${PKG}';
  見る:      npx failure-report serve --open
  配る:      npx failure-report report          （1 ファイルにまとめる）
             npx failure-report publish --to <置き場所>`;
}

/* ---------------------------------------------------------------- open */

function cmdOpen(args: Args) {
  const root = evidenceRoot(args);
  const run = resolveRun(root, (args._ as string[])[0]);
  const report = path.join(run.dir, 'report', 'index.html');
  const target = fs.existsSync(report) ? report : path.join(root, 'index.html');
  openInBrowser(target);
  console.log(`開きました: ${target}`);
}

function openInBrowser(target: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawnSync(cmd, [target], { stdio: 'ignore', shell: process.platform === 'win32' });
}

/* ----------------------------------------------------------- ファイル操作 */

function copyDir(src: string, dest: string, filter?: (file: string) => boolean) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    // latest などのシンボリックリンクは持っていかない（配布先で壊れる）
    if (e.isSymbolicLink()) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to, filter);
    else if (!filter || filter(e.name)) fs.copyFileSync(from, to);
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function hasCommand(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

main();
