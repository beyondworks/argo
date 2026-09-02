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
  // 복원 effect는 본문+deps를 한 정규식으로 묶는다 — 파일 전역 `[draftKey]` 매칭은 무관한 effect가 물고 있으면 fail-open(검수 LOW-1)
  assert.match(src, new RegExp(`useEffect\\(\\(\\) => \\{\\s*\\n\\s*try \\{ const d = localStorage\\.getItem\\(draftKey\\); if \\(d\\) ${setter}\\(\\(cur\\) => cur \\|\\| d\\); \\} catch \\{[^\\n]*\\n\\s*\\}, \\[draftKey\\]\\);`),
    `${label}: 마운트 복원 effect(본문+deps=draftKey — 회사 전환 시 재복원)`);
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
  // 실패 복원은 **미저장일 때만** — 저장된 뒤의 실패에 되돌리면 방·입력창에 같은 안건이 나란히 남아 두 번 적립(검수 HIGH-1)
  assert.match(sendFn, /\} catch \(err\) \{[\s\S]*?if \(!err\?\.data\?\.saved\) setInput\(\(cur\) => cur \|\| text\);/, '미저장(err.data.saved 아님)일 때만 안건 복원');
  assert.doesNotMatch(sendFn, /\n\s*setInput\(\(cur\) => cur \|\| text\);/, '무조건 복원 금지');
});

test('서버: 안건이 저장된 뒤의 실패는 saved=true, 저장 전 실패는 saved 없음 — 라우트가 바디에 싣는다(실호출)', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { mkdtemp } = await import('./helpers/tmp.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { register } = await import('node:module');
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-draft-saved-'));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off(apimsg 관례)
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  const { paths } = await import('../src/workspace.mjs');
  const { runRoomTurn, loadRoom } = await import('../src/room.mjs');
  const seed = async (ws, withCrew) => {
    const p = paths(ws); await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true });
    await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
    await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
    if (withCrew) await writeFile(join(p.root, 'agents', 'pepper.md'), '---\nname: 페퍼\nrole: 검증\nrunner: claude\n---\n검증용.\n');
  };
  // ① 크루 있음 + 러너 자격 없음 → 안건 저장 뒤 chat()이 실패 → saved:true, 방에는 안건+실패 안내
  await seed('ds-saved', true);
  await assert.rejects(runRoomTurn('ds-saved', '@pepper 안건'), (e) => e.saved === true, '저장 뒤 실패에는 saved 표식');
  const room = await loadRoom('ds-saved');
  assert.deepEqual(room.messages.map((m) => m.who), ['user', 'system'], '안건은 저장됐고 실패 안내가 남는다');
  // ② 크루 0명 → 저장 전에 throw → saved 없음, 방은 빈 채(그래서 화면이 입력을 되돌려야 한다)
  await seed('ds-unsaved', false);
  await assert.rejects(runRoomTurn('ds-unsaved', '안건'), (e) => e.saved !== true, '저장 전 실패에는 표식 없음');
  assert.equal((await loadRoom('ds-unsaved')).messages.length, 0);
  // ③ 라우트가 바디에 싣는다
  const route = await import('../app/api/companies/[ws]/room/route.js');
  const post = async (ws) => { const r = await route.POST(new Request(`http://127.0.0.1/api/companies/${ws}/room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '@pepper 안건2' }) }), { params: Promise.resolve({ ws }) }); return { status: r.status, body: await r.json() }; };
  const a = await post('ds-saved'); assert.equal(a.status, 500); assert.equal(a.body.saved, true, '저장 뒤 실패 → saved:true');
  const b = await post('ds-unsaved'); assert.equal(b.status, 500); assert.equal(b.body.saved, false, '저장 전 실패 → saved:false');
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
  const personaSrc = await load('../src/persona.mjs'); // 주석 제거 후 — 주석 한 줄에 거짓 양성(검수 LOW-2)
  assert.match(personaSrc, /const slugify = \(s\) => \(s \|\| ''\)\.toLowerCase\(\)\.normalize\('NFKD'\)\.replace\(\/\[\^a-z0-9-\]\/g, '-'\)/,
    'slugify 문자집합 [a-z0-9-] — @가 슬러그에 들어올 수 없어야 @room·@compete 이름공간이 성립한다');
});
