// 입력 초안 보존(회의실·경쟁 시안) — 유건 요청 2026-09-02: 대화창에 써 둔 글이 페이지 이동 후 돌아와도 남게.
// 크루 채팅의 argo-draft 패턴(마운트 복원 → 입력 따라 저장/제거 → 전송 성공이면 비움, 실패면 유지)을
// 두 페이지에 그대로 이식했다. 클라이언트 컴포넌트라 소스 구간 불변식으로 세 갈래를 각각 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const load = async (rel) => stripComments(await readFile(new URL(rel, import.meta.url), 'utf8'));

// 세 갈래를 한 함수로 — 두 페이지가 같은 계약이라 한쪽만 고쳐지는 드리프트를 같은 단언으로 막는다
function assertDraftWiring(src, { ns, stateVar, setter, label }) {
  const key = `argo-draft:\\$\\{ws\\}:@${ns}`;
  assert.match(src, new RegExp(`const draftKey = \`${key}\`;`), `${label}: 키 이름공간 @${ns} — 크루 슬러그와 불충돌`);
  // ① 마운트 복원 — 이미 입력 중이면(cur) 덮지 않는다
  assert.match(src, new RegExp(`localStorage\\.getItem\\(draftKey\\); if \\(d\\) ${setter}\\(\\(cur\\) => cur \\|\\| d\\);`), `${label}: 마운트 복원`);
  assert.match(src, /\}, \[draftKey\]\);/, `${label}: 복원 effect deps = draftKey(회사 전환 시 재복원)`);
  // ② 입력 따라 저장·빈 값이면 제거(전송으로 비면 자동 삭제)
  assert.match(src, new RegExp(`if \\(${stateVar}\\) localStorage\\.setItem\\(draftKey, ${stateVar}\\); else localStorage\\.removeItem\\(draftKey\\);`), `${label}: 저장/제거`);
  assert.match(src, new RegExp(`\\}, \\[${stateVar}, draftKey\\]\\);`), `${label}: 저장 effect deps`);
  // ③ 저장 불가 환경(사파리 프라이빗) 관용 — 두 effect 모두 try/catch
  const n = (src.match(/localStorage\.(getItem|setItem|removeItem)\(draftKey/g) ?? []).length;
  assert.equal(n, 3, `${label}: localStorage 호출 3곳(get/set/remove) — 늘거나 줄면 계약 변경`);
  for (const m of src.matchAll(/try \{ [^\n]*localStorage\.(getItem|setItem)\(draftKey[^\n]*\} catch \{/g)) assert.ok(m, `${label}: try/catch`);
  assert.equal((src.match(/try \{ [^\n]*localStorage\.[a-zA-Z]+\(draftKey[^\n]*\} catch \{/g) ?? []).length, 2, `${label}: 두 effect 모두 try/catch`);
}

test('회의실: 초안 보존 3갈래 + 전송 성공 비움·실패 복원', async () => {
  const src = await load('../app/c/[ws]/room/page.jsx');
  assertDraftWiring(src, { ns: 'room', stateVar: 'input', setter: 'setInput', label: '회의실' });
  // 전송 = 낙관 표시 후 setInput('')(→ 초안 자동 삭제). 실패면 안건을 되돌려 초안이 재저장된다.
  assert.match(src, /setInput\(''\); setAtt\(\[\]\);/, '전송 시 비움');
  const i = src.indexOf('async function send(e)');
  const sendFn = src.slice(i, src.indexOf('async function endMeeting', i));
  assert.match(sendFn, /\} catch \(err\) \{[\s\S]*?setInput\(\(cur\) => cur \|\| text\);/, '실패 시 안건 복원(이미 새로 쓰는 중이면 덮지 않음)');
});

test('경쟁 시안: 초안 보존 3갈래 + 성공 시에만 비움', async () => {
  const src = await load('../app/c/[ws]/compete/page.jsx');
  assertDraftWiring(src, { ns: 'compete', stateVar: 'prompt', setter: 'setPrompt', label: '경쟁 시안' });
  const i = src.indexOf('async function start(e)');
  const startFn = src.slice(i, src.indexOf('async function openComp', i));
  assert.match(startFn, /const d = await api\(`\/api\/companies\/\$\{ws\}\/compete`, \{ prompt: prompt\.trim\(\), entrants \}\);\s*\n\s*setComp\(d\); setPrompt\(''\);/, '성공 응답 뒤에만 비움 — 실패(catch)면 초안 유지');
  assert.doesNotMatch(startFn.slice(0, startFn.indexOf('await api(')), /setPrompt\(''\)/, '전송 전에 비우면 실패 시 초안이 사라진다');
});

test('세 페이지의 초안 키가 서로 다른 이름공간을 쓴다(크루 슬러그 충돌 0)', async () => {
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /const draftKey = `argo-draft:\$\{ws\}:\$\{slug\}`;/, '크루 채팅 키(기존)');
  // 슬러그 문자집합에 '@'가 없으므로 @room·@compete는 어떤 크루 슬러그와도 같아질 수 없다
  const personaSrc = await readFile(new URL('../src/persona.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(personaSrc, /slug[^\n]*@/, 'slugify가 @를 허용하면 이름공간 분리가 깨진다');
});
