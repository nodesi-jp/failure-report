/**
 * Failure Report のお手本 spec。
 *
 * この 1 本を流すと、報告書のページ（マトリクスの 1 マス）の全欄が埋まる:
 *   お題 / 前提 / 内容 / OK と判断した根拠 / 結果 / 要確認 / 参照 / DB の状態 / スクリーンショット
 * もう 1 本は「ブロック」の正しい形（実行できない理由が付く）。
 *
 * 対象はこのファイルの中に持っている小さな ToDo 画面（page.setContent）。
 * ネットワークも認証も要らないので、どのプロジェクトでもそのまま流せる:
 *
 *   npx playwright test failure-report.example
 *
 * 自分のテストを書くときは、このファイルの形を真似る。各欄が「テストのどこから来るか」は
 * `npx failure-report page` に一覧がある。
 */
import { expect, test } from '@playwright/test';
import { aroundState, details, issue, note, shot, step } from '@nodesi/failure-report';

/** 画面の代わり。実物のアプリでは page.goto(...) になる。 */
const TODO_APP = `<!doctype html><meta charset="utf-8">
<h1>ToDo</h1>
<form id="f"><input id="title" placeholder="やること"><button type="submit">追加</button></form>
<ul id="list"></ul>
<script>
  const list = document.getElementById('list');
  const add = (t) => {
    const li = document.createElement('li');
    li.textContent = t + ' ';
    const del = document.createElement('button'); del.textContent = '削除';
    del.onclick = () => li.remove();
    li.append(del); list.append(li);
  };
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const t = document.getElementById('title').value;
    document.getElementById('title').value = '';
    // 一覧は少し遅れて更新される（実物のアプリでよくある）。expect.poll の出番
    setTimeout(() => add(t), 300);
  };
  ['牛乳を買う', '本を返す'].forEach(add);
</script>`;

/** 「DB の状態」の代わり。実物では API や DB から一覧を取る。 */
const readTodos = (page: import('@playwright/test').Page) =>
  page.locator('#list li').evaluateAll((els) => els.map((el) => ({ title: el.firstChild?.textContent?.trim() })));

// 観点と前提は describe の名前の隣に details で書く（実行しなくても --list で読める）
// わるい例: 観点を書かない → 報告書で「（観点の宣言なし）」の章に落ちる
test.describe('ToDo の追加と削除', details({
  観点: 'ToDo 管理: 追加したものが一覧に出て、削除すると消える',
  前提: '一覧に「牛乳を買う」「本を返す」の 2 件だけがある状態',
  参照: 'https://example.invalid/spec/todo（仕様書の置き場所）',
}), () => {

  test('追加した ToDo が一覧に出て、削除すると消える', async ({ page }, testInfo) => {
    await page.setContent(TODO_APP);

    // 状態が変わる操作は aroundState で挟む → 報告書に「前 / 後 / 差分」の表が出る
    await aroundState(testInfo, 'ToDo 一覧', () => readTodos(page), async () => {

      // step の名前は「操作」と「それで何を確かめたか」を 1 文で。
      // わるい例: 'click add button' / 'assert visible' / 'step 1'
      await step('「掃除をする」を追加して、一覧に 3 件目として出ることを確かめる', async () => {
        await page.getByPlaceholder('やること').fill('掃除をする');
        await page.getByRole('button', { name: '追加' }).click();

        // expect にはメッセージを書く → 「OK と判断した根拠」に日本語の文で出る
        // わるい例: expect(page.getByText('掃除をする')).toBeVisible()  → セレクタしか残らない
        await expect(page.getByText('掃除をする'), '追加した ToDo が一覧に出ること').toBeVisible();

        // 反映が遅れるものは expect.poll。途中の空振りは失敗ではなく「n 回目で成立」と出る
        await expect
          .poll(async () => (await readTodos(page)).length, { message: '一覧が 3 件になること' })
          .toBe(3);

        // shot のラベルは「何をした直後の画面か」。連番は自動
        await shot(page, testInfo, '追加した直後の一覧');
      });

      await step('「本を返す」を削除して、一覧から消えることを確かめる', async () => {
        await page.getByRole('listitem').filter({ hasText: '本を返す' }).getByRole('button', { name: '削除' }).click();
        await expect(page.getByText('本を返す'), '削除した ToDo が一覧に無いこと').toHaveCount(0);
        await shot(page, testInfo, '削除した直後の一覧');
      });
    });

    // 数値・チェックサム・API 応答は note に残す → 「結果」の折りたたみに出る
    await note(testInfo, '最終的な一覧', JSON.stringify(await readTodos(page)));

    // 通ってはいるが人に見てほしいことは issue → 報告書の先頭「要確認」に集まる
    issue(testInfo, '追加が一覧に反映されるまで 300ms かかる。実物でも遅れるなら仕様確認が要る');
  });

  // ブロックの正しい形。test.skip には必ず理由を書く → 「実行できない理由」の欄に出る
  // わるい例: test.skip(true)  → 報告書に「理由が記録されていない」と赤く出る
  test('管理者は他人の ToDo も削除できる', async ({ page }, testInfo) => {
    test.skip(!process.env.EXAMPLE_ADMIN, '管理者アカウント（EXAMPLE_ADMIN）が無い環境では確かめられない');
    await page.setContent(TODO_APP);
    await step('管理者でログインして、他人の ToDo に削除ボタンが出ることを確かめる', async () => {
      await expect(page.getByRole('button', { name: '削除' }).first(), '削除ボタンが出ること').toBeVisible();
      await shot(page, testInfo, '管理者から見た一覧');
    });
  });
});
