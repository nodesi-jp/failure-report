import { spawnSync } from 'node:child_process';

export type CatalogEntry = {
  file: string;
  title: string;
  project: string;
  viewpoints: string[];
  preconditions: string[];
  issues: string[];
};

/**
 * 「どんなテストがあり、何を確かめることになっているか」を、実行せずに集める。
 *
 * playwright test --list を叩いて、宣言（details({観点, 前提})）を読む。
 * 実行結果（run.json）と対にすると、「カバーしている観点」と「実際に流した結果」の
 * 両方が引ける。関数呼び出しで実行時に足した注記はここには出ない。
 */
export function listTests(cwd = process.cwd(), exclude: string[] = ['setup']): CatalogEntry[] {
  const r = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  const start = out.indexOf('{');
  if (start < 0) {
    throw new Error(
      `テスト一覧を取れませんでした（playwright test --list）: ${(r.stderr || out).slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(out.slice(start)) as { suites?: unknown[] };

  const entries: CatalogEntry[] = [];
  const walk = (suites: any[]) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const of = (type: string) =>
            (t.annotations ?? [])
              .filter((a: any) => a.type === type)
              .map((a: any) => String(a.description ?? ''))
              .filter(Boolean);
          entries.push({
            file: suite.file ?? '',
            title: spec.title ?? '',
            project: t.projectName ?? '',
            viewpoints: of('観点'),
            preconditions: of('前提'),
            issues: of('要確認'),
          });
        }
      }
      walk(suite.suites ?? []);
    }
  };
  walk((parsed.suites as any[]) ?? []);
  // 認証の下ごしらえなどはカタログに出さない（報告書の exclude と揃える）
  return entries.filter((e) => !exclude.includes(e.project));
}

/** 観点ごとにまとめて読める形にする。 */
export function formatCatalog(entries: CatalogEntry[]): string {
  if (!entries.length) return 'テストが見つかりません';

  const groups = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    for (const v of e.viewpoints.length ? e.viewpoints : ['（観点の宣言なし）']) {
      groups.set(v, [...(groups.get(v) ?? []), e]);
    }
  }

  const lines = [`テスト ${entries.length} 件 / 観点 ${groups.size} 個（実行はしていない宣言のみ）`, ''];
  for (const [viewpoint, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    lines.push(`■ ${viewpoint}`);
    const preconditions = [...new Set(list.flatMap((e) => e.preconditions))];
    if (preconditions.length) lines.push(`  前提: ${preconditions.join(' / ')}`);
    // 同じテストがロールごとに複数あるのでまとめる
    const byTitle = new Map<string, Set<string>>();
    for (const e of list) {
      const key = `${e.file} › ${e.title}`;
      byTitle.set(key, (byTitle.get(key) ?? new Set()).add(e.project));
    }
    for (const [key, projects] of byTitle) {
      lines.push(`  - ${key}  [${[...projects].filter(Boolean).join(', ')}]`);
    }
    const issues = [...new Set(list.flatMap((e) => e.issues))];
    for (const i of issues) lines.push(`  要確認: ${i}`);
    lines.push('');
  }
  return lines.join('\n');
}
