import fs from 'node:fs';
import path from 'node:path';

/** 実行 ID のかたち（例: 2026-08-31_212000）。CI では任意の文字列も許す。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(['latest', 'index.html', '_site', 'transfer-summary.json']);

export type Attachment = {
  name: string;
  contentType: string;
  /** 実行フォルダからの相対パス。テキストを直接持つ添付では省略される。 */
  path?: string;
  body?: string;
};

export type CaseStep = {
  title: string;
  durationMs: number;
  error?: string;
  /** step = 手順、expect = 判定（何をもって OK / NG としたか）、深さは nest */
  kind?: 'step' | 'expect';
  nest?: number;
};

export type CaseRecord = {
  title: string;
  project: string;
  status: string;
  durationMs: number;
  steps: CaseStep[];
  annotations: string[];
  attachments: Array<string | Attachment>;
  error?: string;
};

export type RunMeta = {
  runId: string;
  /** テストセッション（同じ塊として扱う実行のまとまり）。未設定なら runId と同じ */
  session?: string;
  environment: { name: string; baseURL: string };
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  status: string;
  counts: Record<string, number>;
  tool?: { playwright?: string; workers?: number; projects?: string[] };
  report?: {
    title?: string;
    purpose?: string;
    preconditions?: string[];
    scope?: string[];
    author?: string;
  };
  transfer: {
    uploadBytes: number;
    uploadCount: number;
    downloadBytes: number;
    downloadCount: number;
    upload: string;
    download: string;
  };
  cases: CaseRecord[];
};

export type RunEntry = { id: string; dir: string; meta: RunMeta };

/** 実行フォルダを新しい順に読む。run.json が無いもの（実行中・壊れたもの）は無視する。 */
export function listRuns(root: string): RunEntry[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !RESERVED.has(e.name) && RUN_ID_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .flatMap((id) => {
      const dir = path.join(root, id);
      const metaPath = path.join(dir, 'run.json');
      if (!fs.existsSync(metaPath)) return [];
      try {
        return [{ id, dir, meta: JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta }];
      } catch {
        return [];
      }
    });
}

/** 同じセッションの実行を古い順に返す。 */
export function runsInSession(root: string, session: string): RunEntry[] {
  return listRuns(root)
    .filter((r) => (r.meta.session ?? r.id) === session)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readRun(root: string, id: string): RunEntry | null {
  return listRuns(root).find((r) => r.id === id) ?? null;
}

/** 実行 ID を解決する。'latest' と省略は最新の実行を指す。 */
export function resolveRun(root: string, id?: string): RunEntry {
  const runs = listRuns(root);
  if (!runs.length) throw new Error(`実行がありません: ${root}`);
  if (!id || id === 'latest') return runs[0]!;
  const found = runs.find((r) => r.id === id);
  if (!found) throw new Error(`実行が見つかりません: ${id}`);
  return found;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** 一覧・共有ページで共通に使う見た目。 */
export const STYLE = `
 :root{color-scheme:light dark;--fg:#131a17;--muted:#5f6f68;--line:#dfe6e1;--rule:#c6d2cb;--ok:#0d7a52;--ng:#a03028;--bg:#fff;--card:#f6f8f7}
 @media (prefers-color-scheme:dark){:root{--fg:#e6ece9;--muted:#9fb0a8;--line:#2b3532;--rule:#3a4642;--ok:#4fc48d;--ng:#f08b7f;--bg:#111613;--card:#19201d}}
 *{box-sizing:border-box}
 body{font-family:"Hiragino Sans",system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg);line-height:1.7}
 .wrap{max-width:960px;margin:40px auto;padding:0 20px}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:32px 0 8px}
 .lede{color:var(--muted);margin:0 0 24px;font-size:14px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th{text-align:left;font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:500;padding-bottom:8px;border-bottom:1px solid var(--rule)}
 td{border-top:1px solid var(--line);padding:9px 8px 9px 0;vertical-align:top}
 td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
 a{color:var(--ok)} .ok{color:var(--ok)} .ng{color:var(--ng);font-weight:700} .muted{color:var(--muted)}
 .cards{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 24px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:140px}
 .card b{display:block;font-size:20px;font-variant-numeric:tabular-nums;font-weight:600}
 .card span{font-size:11px;letter-spacing:.08em;color:var(--muted)}
 .case{border-top:1px solid var(--line);padding:14px 0}
 .case h3{font-size:14px;margin:0 0 6px;font-weight:600}
 .steps{margin:0;padding:0 0 0 18px;font-size:13px;color:var(--muted)}
 .shots{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
 .shots figure{margin:0;width:240px}
 .shots img{width:100%;border:1px solid var(--line);border-radius:4px;display:block;cursor:zoom-in}
 .shots input{display:none}
 .shots input:checked + label img{cursor:zoom-out}
 .shots figure:has(input:checked){width:100%}
 .shots figcaption{font-size:11px;color:var(--muted);margin-top:4px}
 /* マトリクスは本文より広く使う（列が多いので） */
 .matrix{position:relative;left:50%;transform:translateX(-50%);width:min(94vw,1600px);overflow-x:auto}
 /* 表は中身の幅で組む。見出しが縦に潰れないよう、値の列は折り返さない */
 .matrix table{font-size:13px;width:auto;min-width:100%}
 .matrix th,.matrix td{border-left:1px solid var(--line);padding:7px 14px}
 .matrix th:first-child,.matrix td:first-child{border-left:0;padding-left:0;white-space:normal}
 .matrix th.n,.matrix td.cell{white-space:nowrap;min-width:6.5em;text-align:center}
 .matrix th.n{vertical-align:bottom}
 .matrix tbody tr:nth-child(even) td,.matrix tr:nth-child(even) td{background:color-mix(in srgb,var(--card) 60%,transparent)}
 .matrix td.cell{font-size:15px}
 .statehead{margin:10px 0 4px}
 tr.group th{background:var(--soft,#f2f2f0);font-weight:600;text-align:left;padding-top:12px}
 .matrix td.cell a{text-decoration:none}
 .matrix tr.foot td{border-top:1px solid var(--rule);font-size:12px;background:none}
 .matrix td.failed,.matrix td.timedOut{background:color-mix(in srgb,var(--ng) 14%,transparent)}
 .matrix h3{margin:28px 0 6px} .matrix h3 .jump{font-size:12px;font-weight:400;margin-left:8px}
 .matrix .where{font-size:11px;color:var(--muted);margin:0 0 6px}
 details{font-size:13px;margin-top:8px} summary{cursor:pointer;color:var(--muted)}
 pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font-size:12px}
`;

/**
 * evidence/index.html を書き出す。
 *
 * セッション（＝全部流して、落ちたものを流し直すまでの一塊）ごとにまとめる。
 * ここを開けば、どのセッションが何件 OK / NG / ブロックだったかと、
 * その報告書へのリンクが並ぶ。URL を人に聞かなくて済むように。
 */
export function writeIndex(root: string, title = '自動テスト エビデンス'): string {
  const runs = listRuns(root);

  // セッションごとに束ねる（新しい順）
  const sessions = new Map<string, RunEntry[]>();
  for (const r of runs) {
    const key = r.meta.session ?? r.id;
    sessions.set(key, [...(sessions.get(key) ?? []), r]);
  }

  const rows = [...sessions.entries()]
    .map(([session, list]) => {
      const ordered = [...list].sort((a, b) => a.id.localeCompare(b.id));
      const first = ordered[0]!;

      // ケースごとに最後の結果を採って数える
      const last = new Map<string, string>();
      for (const r of ordered) {
        for (const c of r.meta.cases ?? []) last.set(`${c.project}|${c.title}`, c.status);
      }
      const tally = { ok: 0, ng: 0, blocked: 0 };
      for (const status of last.values()) {
        if (status === 'passed') tally.ok++;
        else if (status === 'skipped') tally.blocked++;
        else tally.ng++;
      }

      const report = ordered.find((r) => fs.existsSync(path.join(r.dir, 'report.html')));
      const badge = tally.ng
        ? `<span class="ng">NG ${tally.ng}</span>`
        : '<span class="ok">全て OK</span>';
      const duration = ordered.reduce((n, r) => n + (r.meta.durationMs ?? 0), 0);
      const when = first.meta.startedAt ? new Date(first.meta.startedAt).toLocaleString('ja-JP') : '';
      const runsCell = ordered
        .map(
          (r, i) =>
            `<a href="./${r.id}/report/index.html" title="${escapeHtml(r.id)}">${i + 1}回目</a>`,
        )
        .join(' ');

      return `<tr>
      <td>${report ? `<a href="./${report.id}/report.html"><b>報告書</b></a>` : '<span class="muted">未作成</span>'}
        <div class="muted">${escapeHtml(session)}</div></td>
      <td>${escapeHtml(first.meta.environment?.name ?? '')}</td>
      <td>${escapeHtml(when)}</td>
      <td>${badge}</td>
      <td class="n">${tally.ok}</td>
      <td class="n">${tally.ng}</td>
      <td class="n">${tally.blocked}</td>
      <td class="n">${formatDuration(duration)}</td>
      <td>${runsCell}</td>
    </tr>`;
    })
    .join('\n');

  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<div class="wrap">
<h1>${escapeHtml(title)}</h1>
<p class="lede">テストセッションごとにまとめています。1 セッション＝「全部流す → 落ちたものを流し直す」までの一塊で、
件数はその中の最後の結果で数えています。「報告書」がそのセッションの成果物です。</p>
<table>
<tr><th>セッション</th><th>環境</th><th>実行日時</th><th>結果</th><th class="n">OK</th><th class="n">NG</th><th class="n">ブロック</th><th class="n">所要</th><th>各回</th></tr>
${rows || '<tr><td colspan="9" class="muted">まだ実行がありません</td></tr>'}
</table>
</div>`;

  const file = path.join(root, 'index.html');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}
