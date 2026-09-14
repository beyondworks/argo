// 채널 기록 스크롤백(출시 전수 검사 2026-09-14 C-1: 최신 100건 상한·이전 기록 불가) — 구조 핀. 행동은 로컬 스택 E2E(150건 채널)로
// 실측: 초기 99/100 → '이전 메시지 보기'·위로 스크롤 → 150·'대화의 시작', 휠로 올린 뒤 로드해도 같은 메시지가 같은 오프셋.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

test('스크롤백: 가장 오래된 id 앞을 한 페이지씩(lt·desc·PAGE), 첫 페이지가 꽉 찼을 때만 더 있음, 붙인 높이만큼 scrollTop 보정', () => {
  const app = read('apps/messenger/src/App.jsx');
  const ch = app.slice(app.indexOf('function Channel('), app.indexOf('function Composer('));
  assert.match(ch, /\.eq\('channel_id', chId\)\.lt\('id', first\)\.order\('id', \{ ascending: false \}\)\.limit\(PAGE\)/, '역방향 페이지 질의');
  assert.match(ch, /if \(!afterId\) setHasMore\(rows\.length >= PAGE\)/, '첫 로드에서 더 있음 판정');
  assert.match(ch, /setHasMore\(rows\.length >= PAGE\);\n\s+await hydrate\(list\.map\(\(m\) => m\.id\)\);/, '이전 페이지도 첨부·반응을 채운다');
  assert.match(ch, /prepend\.current = el \? \{ h: el\.scrollHeight, top: el\.scrollTop \} : null;/, '붙이기 전 높이·위치 기록');
  assert.match(ch, /useLayoutEffect\(\(\) => \{ const p = prepend\.current; const el = feed\.current; if \(p && el\) \{ el\.scrollTop = el\.scrollHeight - p\.h \+ p\.top; prepend\.current = null; \} \}, \[msgs\]\);/, '렌더 직후 동기 보정(깜빡임 없음)');
  assert.match(ch, /if \(el\.scrollTop < 120\) loadOlder\(\);/, '위로 스크롤하면 자동 로드');
  assert.match(ch, /if \(!first \|\| older \|\| !hasMore\) return;/, '중복 로드·끝 도달 가드');
  assert.match(ch, /useEffect\(\(\) => \{ setHasMore\(true\); prepend\.current = null; \}, \[chId\]\);/, '채널 바뀌면 초기화');
  assert.match(ch, /tab === 'all' && all\.length > 0 && \(older/, '컨트롤은 전체 탭·기록 있을 때만');
  const m = read('apps/messenger/src/i18n.js');
  for (const k of ['thread.older', 'thread.loading', 'thread.start']) assert.ok(new RegExp(`'${k.replace('.', '\\.')}': \\['[^']+', '[^']+'\\]`).test(m), `${k} ko/en`);
});
