// Material Symbols path 추출(한 번 돌리는 도구 — 아이콘을 더하거나 바꿀 때만). 런타임 의존성 없음: 앱은 src/icons.jsx에 복사된 path만 쓴다.
// 사용: npm pack @material-symbols/svg-400 @material-symbols/svg-500 → 각각 압축 해제 → node scripts/extract-material-icons.mjs <svg-400 package 폴더> <svg-500 package 폴더>
// src/icons.jsx의 MATERIAL(앱 이름 → Material 이름)과 FILLED(채운 모양이 필요한 앱 이름)를 읽어, '생성 시작'~'생성 끝' 사이의 MS(굵기 400)·MS5(500) 표를 다시 쓴다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [pkg, pkg5] = process.argv.slice(2);
const ok = (d) => d && existsSync(`${d}/outlined`);
if (!ok(pkg) || !ok(pkg5)) { console.error('사용: node scripts/extract-material-icons.mjs <svg-400 package 폴더> <svg-500 package 폴더>'); process.exit(1); }
const file = fileURLToPath(new URL('../src/icons.jsx', import.meta.url));
const src = readFileSync(file, 'utf8');
const block = (name, open, close) => { const i = src.indexOf(name); const a = src.indexOf(open, i); return src.slice(a, src.indexOf(close, a) + 1); };
const material = Object.fromEntries([...block('export const MATERIAL', '{', '}').matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
const filled = [...block('export const FILLED', '[', ']').matchAll(/'(\w+)'/g)].map((m) => m[1]);
const pathOf = (n, root = pkg) => { const f = `${root}/outlined/${n}.svg`; if (!existsSync(f)) throw new Error(`없는 아이콘: ${n}`); const svg = readFileSync(f, 'utf8'); if (!svg.includes('viewBox="0 -960 960 960"')) throw new Error(`viewBox가 다르다: ${n}`); return [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]).join(' '); };
const want = [...new Set(Object.values(material))].sort();
const table = (root) => { const rows = []; for (const n of want) rows.push(`  ${n}: '${pathOf(n, root)}',`); for (const app of filled) { const n = material[app]; rows.push(`  '${n}-fill': '${pathOf(`${n}-fill`, root)}',`); } return rows.join('\n'); };
const version = JSON.parse(readFileSync(`${pkg}/package.json`, 'utf8')).version;
const version5 = JSON.parse(readFileSync(`${pkg5}/package.json`, 'utf8')).version;
const start = '// ── 생성 시작'; const end = '// ── 생성 끝';
const a = src.indexOf(start); const b = src.indexOf(end);
if (a < 0 || b < 0) throw new Error('icons.jsx에 생성 표지가 없다');
const out = `${src.slice(0, a)}${start}(scripts/extract-material-icons.mjs · @material-symbols/svg-400 ${version} · svg-500 ${version5} outlined) ──\nconst MS = {\n${table(pkg)}\n};\nconst MS5 = {\n${table(pkg5)}\n};\n${src.slice(b)}`;
writeFileSync(file, out);
console.log(`${want.length}개 + 채운 모양 ${filled.length}개 × 굵기 400·500 → src/icons.jsx (판 ${version}·${version5})`);
