import { escapeHtml } from './site';

export type Change = {
  kind: '追加' | '削除' | '変更';
  key: string;
  before?: unknown;
  after?: unknown;
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
};

export type StateDiff = {
  name: string;
  before: unknown;
  after: unknown;
  changes: Change[];
  /** 件数（配列のとき） */
  counts?: { before: number; after: number };
};

const KEY_FIELDS = ['id', 'projectId', 'uuid', 'key', 'name', 'title', 'path', 'email'];

function keyOf(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    for (const f of KEY_FIELDS) {
      const v = (value as Record<string, unknown>)[f];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return `#${index}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 操作の前後を突き合わせて、増えた・減った・変わったを出す。 */
export function diffState(name: string, before: unknown, after: unknown): StateDiff {
  const changes: Change[] = [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const b = new Map(before.map((v, i) => [keyOf(v, i), v]));
    const a = new Map(after.map((v, i) => [keyOf(v, i), v]));
    for (const [key, value] of a) {
      if (!b.has(key)) changes.push({ kind: '追加', key, after: value });
      else {
        const fields = diffFields(b.get(key), value);
        if (fields.length) changes.push({ kind: '変更', key, before: b.get(key), after: value, fields });
      }
    }
    for (const [key, value] of b) if (!a.has(key)) changes.push({ kind: '削除', key, before: value });
    return { name, before, after, changes, counts: { before: before.length, after: after.length } };
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const f of diffFields(before, after)) {
      changes.push({ kind: '変更', key: f.field, before: f.before, after: f.after });
    }
    return { name, before, after, changes };
  }

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({ kind: '変更', key: name, before, after });
  }
  return { name, before, after, changes };
}

function diffFields(before: unknown, after: unknown) {
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  if (!isPlainObject(before) || !isPlainObject(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ field: '値', before, after });
    }
    return out;
  }
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      out.push({ field, before: before[field], after: after[field] });
    }
  }
  return out;
}

function short(value: unknown): string {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? 'null').length > 120 ? `${text!.slice(0, 120)}…` : (text ?? 'null');
}

/** 報告書に埋める「操作前後の状態」。 */
export function renderStateHtml(diff: StateDiff): string {
  const counts = diff.counts
    ? `<span class="muted">${diff.counts.before} 件 → ${diff.counts.after} 件</span>`
    : '';
  const rows = diff.changes.length
    ? diff.changes
        .map((c) => {
          const detail = c.fields
            ? c.fields.map((f) => `${escapeHtml(f.field)}: ${escapeHtml(short(f.before))} → ${escapeHtml(short(f.after))}`).join('<br>')
            : c.kind === '追加'
              ? escapeHtml(short(c.after))
              : c.kind === '削除'
                ? escapeHtml(short(c.before))
                : `${escapeHtml(short(c.before))} → ${escapeHtml(short(c.after))}`;
          const kindClass = c.kind === '削除' ? 'ng' : c.kind === '追加' ? 'ok' : '';
          return `<tr><td class="${kindClass}">${c.kind}</td><td>${escapeHtml(c.key)}</td><td>${detail}</td></tr>`;
        })
        .join('\n')
    : '<tr><td colspan="3" class="muted">変化なし</td></tr>';

  return `<div class="state">
<p class="statehead"><b>操作前後の状態: ${escapeHtml(diff.name)}</b> ${counts}</p>
<table><tr><th>差分</th><th>対象</th><th>内容</th></tr>${rows}</table>
<details><summary>取得した生データ</summary><pre>前:
${escapeHtml(JSON.stringify(diff.before, null, 2).slice(0, 8000))}

後:
${escapeHtml(JSON.stringify(diff.after, null, 2).slice(0, 8000))}</pre></details>
</div>`;
}
