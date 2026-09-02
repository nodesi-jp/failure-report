import fs from 'node:fs';
import path from 'node:path';
import { test as base, type Page, type TestInfo } from '@playwright/test';
import { paths } from './runContext';

const counters = new Map<string, number>();

export function safeName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

/**
 * 画面のスクリーンショットを撮り、実行ごとのフォルダへ連番で保存しつつ
 * レポートにも添付する。ラベルは「何をした直後か」が分かる日本語で書くこと。
 *
 *   await shot(page, testInfo, 'ログインしてホームが開いたところ');
 */
export async function shot(page: Page, testInfo: TestInfo, label: string): Promise<string> {
  const dir = path.join(paths.shots, safeName(testInfo.project.name), safeName(testInfo.title));
  fs.mkdirSync(dir, { recursive: true });

  const n = (counters.get(dir) ?? 0) + 1;
  counters.set(dir, n);

  const seq = String(n).padStart(2, '0');
  const file = path.join(dir, `${seq}-${safeName(label)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // path で添付する（run.json に実体の場所が残り、共有用レポートから引ける）
  await testInfo.attach(`${seq} ${label}`, { path: file, contentType: 'image/png' });
  return file;
}

/**
 * 手順を「何をして、何を確かめたか」の形でレポートに残す。
 *
 *   await step('ファイルを2つアップロードして、一覧に出ることを確かめる', async () => { ... });
 *
 * レポートの手順名がそのまま読み物になるので、
 * 「クリック」「アサート」ではなく、人に説明する言葉で書くこと。
 */
export async function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  return base.step(title, body);
}

/** 補足メモをレポートに残す（数値・チェックサム・API 応答など）。 */
export async function note(testInfo: TestInfo, title: string, text: string): Promise<void> {
  await testInfo.attach(title, { body: text, contentType: 'text/plain' });
}

/* ------------------------------------------------ 報告書のための書き込み */

/** 注記の種類。報告書はこの種類ごとに章立てする。 */
export const ANNOTATION = {
  viewpoint: '観点',
  precondition: '前提',
  reference: '参照',
  issue: '要確認',
} as const;

/**
 * このテストで「何を確かめるのか」（テスト観点）を宣言する。
 * 報告書では観点ごとにケースがまとまる。
 *
 *   viewpoint(testInfo, '権限: 一般ユーザーに組織管理メニューが出ないこと');
 */
export function viewpoint(testInfo: TestInfo, ...texts: string[]): void {
  for (const description of texts) {
    testInfo.annotations.push({ type: ANNOTATION.viewpoint, description });
  }
}

/**
 * このテストの前提（事前条件・使うアカウント・用意したデータ）を宣言する。
 *
 *   precondition(testInfo, '組織管理者でログイン済み', 'プロジェクトが 1 件もない状態');
 */
export function precondition(testInfo: TestInfo, ...texts: string[]): void {
  for (const description of texts) {
    testInfo.annotations.push({ type: ANNOTATION.precondition, description });
  }
}

/**
 * 「通ってはいるが、これは NG（要確認）」を残す。
 *
 * 間欠的に落ちる、仕様として疑わしい、直っていない不具合を踏んでいる — など、
 * 結果が緑でも人に見てほしいことを書く。報告書の先頭に一覧で出る。
 *
 *   issue(testInfo, '追加直後に削除すると確認ダイアログが出ないことがある（3回中2回）');
 */
export function issue(testInfo: TestInfo, ...texts: string[]): void {
  for (const description of texts) {
    testInfo.annotations.push({ type: ANNOTATION.issue, description });
  }
}

/** 参照（チケット・仕様書・手順書）を残す。 */
export function reference(testInfo: TestInfo, ...texts: string[]): void {
  for (const description of texts) {
    testInfo.annotations.push({ type: ANNOTATION.reference, description });
  }
}

/**
 * Playwright の標準のアノテーション枠（テスト名の隣に書く details）を組み立てる。
 *
 *   test.describe('API を直接叩いたときのガード', details({
 *     観点: '権限: 画面を経由せず API を直接叩いても、権限のないデータは取得できない',
 *     前提: '対象ロールでログイン済み',
 *   }), () => { ... });
 *
 *   test('認証トークン無しでは何も取得できない', details({ 要確認: '間欠的に落ちる' }), async () => {});
 *
 * describe に書いたものは中の全ケースに効く（Playwright がそう畳んでくれる）。
 * 実行中に足すときは viewpoint() / precondition() / issue() を使う。
 */
export function details(spec: {
  観点?: string | string[];
  前提?: string | string[];
  参照?: string | string[];
  要確認?: string | string[];
  /**
   * その観点に合った表の軸。報告書はこれで観点ごとの表を組む。
   *
   *   軸: { 対象: 'フォルダ' }                     → 行=対象 / 列=ロール
   *   軸: { 対象: 'フォルダ', 共有先: '外部ユーザー' } → 行=対象 / 列=共有先
   *
   * 宣言しなければ、既定の「テストケース × ロール」の表になる。
   */
  軸?: Record<string, string>;
  tag?: string | string[];
}): { annotation: Array<{ type: string; description: string }>; tag?: string | string[] } {
  const annotation: Array<{ type: string; description: string }> = [];
  for (const type of ['観点', '前提', '参照', '要確認'] as const) {
    const value = spec[type];
    if (!value) continue;
    for (const description of Array.isArray(value) ? value : [value]) {
      annotation.push({ type, description });
    }
  }
  for (const [axis, value] of Object.entries(spec.軸 ?? {})) {
    annotation.push({ type: '軸', description: `${axis}=${value}` });
  }
  return spec.tag ? { annotation, tag: spec.tag } : { annotation };
}

export type StatePhase = '前' | '後';

/** 状態の添付名。報告書はこの名前で前後を対にする。 */
export function stateAttachmentName(name: string, phase: StatePhase): string {
  return `状態 ${name} ${phase}`;
}

/**
 * 操作前・操作後の状態（DB / API から取った一覧など）を報告書に残す。
 * 前後の両方を残すと、報告書に差分の表が出る。
 */
export async function recordState(
  testInfo: TestInfo,
  name: string,
  phase: StatePhase,
  data: unknown,
): Promise<void> {
  await testInfo.attach(stateAttachmentName(name, phase), {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  });
}

/**
 * 「操作の前後で状態を撮る」をひとまとめにする。
 *
 *   await aroundState(testInfo, 'ToDo 一覧', () => api.listTodos(), async () => {
 *     await addTodo(name);   // ← この操作の前後が記録される
 *   });
 */
export async function aroundState<T>(
  testInfo: TestInfo,
  name: string,
  read: () => Promise<unknown> | unknown,
  body: () => Promise<T>,
): Promise<T> {
  await recordState(testInfo, name, '前', await read());
  try {
    return await body();
  } finally {
    await recordState(testInfo, name, '後', await read());
  }
}
