// README の CLI の章を `failure-report --help` の出力で置き換える（手で書くとずれるため）。
//   npm run readme
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = execFileSync('node', [path.join(root, 'dist/cli.js'), '--help'], { encoding: 'utf-8' }).trim();
const readme = path.join(root, 'README.md');
const begin = '<!-- help:begin -->';
const end = '<!-- help:end -->';
const s = fs.readFileSync(readme, 'utf-8');
const i = s.indexOf(begin);
const j = s.indexOf(end);
if (i < 0 || j < i) throw new Error(`README.md に ${begin} 〜 ${end} がありません`);
const block = `${begin}\n\`\`\`\n${help}\n\`\`\`\n${end}`;
fs.writeFileSync(readme, s.slice(0, i) + block + s.slice(j + end.length));
console.log('README.md の CLI の章を --help で更新しました');
