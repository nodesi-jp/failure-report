import type { RunMeta, CaseRecord, RunEntry } from './site';

export type Gap = { title: string; project: string; missing: string[] };

const has = (c: CaseRecord, type: string) =>
  (c.annotations ?? []).some((a) => a.startsWith(`${type}: `) && a.length > type.length + 2);

/**
 * 報告書として足りていないところを挙げる。
 *
 * 「報告書に何を載せるか」は、テスト側が何を宣言したかで決まる。
 * その宣言が抜けているケースをここで機械的に見つけられるようにして、
 * 決めごとを「守られているか確かめられるもの」にする。
 */
export function findGaps(meta: RunMeta): Gap[] {
  return (meta.cases ?? [])
    .filter((c) => c.status !== 'skipped')
    .map((c) => {
      const missing: string[] = [];
      if (!has(c, '観点')) missing.push('観点');
      if (!has(c, '前提')) missing.push('前提');
      if (!c.steps?.some((s) => (s.kind ?? 'step') === 'step')) missing.push('手順');
      if (!c.steps?.some((s) => s.kind === 'expect')) missing.push('判定');
      const attachments = (c.attachments ?? []).map((a) => (typeof a === 'string' ? { name: a, contentType: '' } : a));
      if (!attachments.some((a) => /^image\//.test(a.contentType ?? ''))) missing.push('スクリーンショット');
      return { title: c.title, project: c.project, missing };
    })
    .filter((g) => g.missing.length);
}

/** 端末・CI 用のまとめ。 */
export function formatGaps(meta: RunMeta): string {
  const gaps = findGaps(meta);
  const total = (meta.cases ?? []).filter((c) => c.status !== 'skipped').length;
  if (!gaps.length) return `報告書の記述は揃っています（${total} 件）`;

  const byFile = new Map<string, Gap[]>();
  for (const g of gaps) {
    const file = g.title.split(' › ')[0] ?? '';
    byFile.set(file, [...(byFile.get(file) ?? []), g]);
  }

  const lines = [`報告書の記述が足りないケース: ${gaps.length} / ${total} 件`, ''];
  for (const [file, list] of [...byFile.entries()].sort()) {
    lines.push(file);
    // 同じテストがロールごとに複数あるので、テスト名でまとめる
    const byTitle = new Map<string, Set<string>>();
    for (const g of list) {
      const name = g.title.split(' › ').slice(1).join(' › ');
      const set = byTitle.get(name) ?? new Set<string>();
      for (const m of g.missing) set.add(m);
      byTitle.set(name, set);
    }
    for (const [name, missing] of byTitle) {
      lines.push(`  ${name}\n    足りない: ${[...missing].join(' / ')}`);
    }
  }
  lines.push('');
  lines.push('観点: suiteViewpoint() か viewpoint() / 前提: suitePrecondition() か precondition()');
  lines.push('手順: step() で包む / スクリーンショット: shot() を要所で撮る');
  return lines.join('\n');
}


export type StaleSkip = {
  title: string;
  project: string;
  /** いまも収集されているか。false は「対象外にした」もの。 */
  collected?: boolean;
  /** 連続でブロックされた回数 */
  skipped: number;
  /** 最後に実行された実行 ID（一度も無ければ null） */
  lastRun: string | null;
};

/**
 * ずっと実行されていないテストを見つける。
 *
 * ブロックは「対象外」と「不具合で止めている」の区別が付かないまま積もる。
 * 何回も続けてブロックされているものは、忘れられている可能性が高いので名指しする。
 */
export function findStaleSkips(
  runs: RunEntry[],
  threshold = 3,
  /** いま収集されるテスト（catalog）。渡すと、もう収集されないものは無視する。 */
  collected?: Array<{ project: string; file: string; title: string }>,
): StaleSkip[] {
  const streak = new Map<string, StaleSkip>();

  // runs は新しい順。各テストについて、先頭から連続でブロックされている回数を数える
  for (const { id, meta } of runs) {
    for (const c of meta.cases ?? []) {
      const key = `${c.project}\u0000${c.title}`;
      const e = streak.get(key) ?? { title: c.title, project: c.project, skipped: 0, lastRun: null };
      if (e.lastRun) continue; // すでに実行された回を見つけている
      if (c.status === 'skipped') e.skipped++;
      else e.lastRun = id;
      streak.set(key, e);
    }
  }

  return [...streak.values()]
    .filter((e) => !e.lastRun && e.skipped >= threshold)
    .map((e) => ({ ...e, collected: isCollected(e, collected) }))
    .sort((a, b) => b.skipped - a.skipped);
}

/** いまも収集されているか（収集されないものは「対象外にした」もの）。 */
function isCollected(
  e: StaleSkip,
  collected?: Array<{ project: string; file: string; title: string }>,
): boolean {
  if (!collected) return true;
  return collected.some(
    (c) => c.project === e.project && e.title.startsWith(c.file) && e.title.endsWith(c.title),
  );
}

export function formatStaleSkips(
  runs: RunEntry[],
  threshold = 3,
  collected?: Array<{ project: string; file: string; title: string }>,
): string {
  const stale = findStaleSkips(runs, threshold, collected);
  if (!stale.length) return '';

  const group = (list: StaleSkip[]) => {
    const byTitle = new Map<string, StaleSkip[]>();
    for (const s of list) byTitle.set(s.title, [...(byTitle.get(s.title) ?? []), s]);
    return byTitle;
  };

  const lines: string[] = [];
  const forgotten = group(stale.filter((s) => s.collected !== false));
  const excluded = group(stale.filter((s) => s.collected === false));

  if (forgotten.size) {
    lines.push(`ずっと実行されていないテスト: ${forgotten.size} 件（直近 ${runs.length} 回の記録から）`);
    lines.push('');
    for (const [title, list] of forgotten) {
      lines.push(`  ${title}`);
      lines.push(
        `    ${Math.max(...list.map((s) => s.skipped))} 回連続でブロック / 一度も実行されていない [${list.map((s) => s.project).join(', ')}]`,
      );
    }
    lines.push('');
    lines.push('「対象外だから流さない」のか「不具合で止めている」のかを確かめること。');
    lines.push('不具合なら fixme を外して赤で出す。');
    lines.push('');
  }

  if (excluded.size) {
    // 隠さない。誰かが「対象外」と決めた結果であって、その判断自体が誤っている可能性がある
    lines.push(`いま収集していないテスト: ${excluded.size} 件（対象外として外している）`);
    lines.push('');
    const byProject = new Map<string, Set<string>>();
    for (const [title, list] of excluded) {
      for (const s of list) {
        const file = title.split(' › ')[0] ?? title;
        byProject.set(s.project, (byProject.get(s.project) ?? new Set()).add(file));
      }
    }
    for (const [project, files] of byProject) {
      lines.push(`  ${project}: ${[...files].join(', ')}`);
    }
    lines.push('');
    lines.push('この「対象外」は人が決めた宣言（どのロールがどの画面を使うか）に基づく。');
    lines.push('宣言が間違っていれば、これはそのまま確認の抜けになる。定期的に妥当性を見直すこと。');
  }

  return lines.join('\n');
}


/**
 * 理由の無いブロックの正体を推測する。
 *
 * Playwright の serial モードでは、前のテストが落ちると後続が理由なしでブロックされる。
 * 報告書に「理由なし」と出るだけだと、確認できていない事実が埋もれる。
 * 同じファイル・同じロールで先に失敗しているものがあれば、それが原因。
 */
export function inferSkipReason(c: CaseRecord, all: CaseRecord[]): string | null {
  const declared = (c.annotations ?? []).some((a) => a.startsWith('skip:') || a.startsWith('fixme'));
  if (c.status !== 'skipped' || declared) return null;

  const file = c.title.split(' › ')[0];
  const blocker = all.find(
    (x) =>
      x.project === c.project &&
      x.title.split(' › ')[0] === file &&
      x.status !== 'passed' &&
      x.status !== 'skipped',
  );
  if (!blocker) return null;
  return `同じファイルの「${blocker.title.split(' › ').at(-1)}」が失敗したため、serial の後続として実行されなかった（テストが落ちたのではない）`;
}

/** 前の失敗に巻き込まれて実行されなかったものを数える。 */
export function findBlockedByFailure(meta: RunMeta): Array<{ case: CaseRecord; reason: string }> {
  const all = meta.cases ?? [];
  return all
    .map((c) => ({ case: c, reason: inferSkipReason(c, all) }))
    .filter((x): x is { case: CaseRecord; reason: string } => !!x.reason);
}
