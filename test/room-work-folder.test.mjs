// 회의실 작업 폴더 — 유건 요청(2026-09-02, 회의실 개선 4/6): 회의실에서 폴더를 고르면 그 회의에서 발언하는 크루
// **전원**이 같은 폴더를 "지금 일할 폴더"로 받는다. 크루 채팅의 고정 폴더(.workroots.json pins)와 같은 저장소·검증·
// API·컴포넌트를 재사용하고(키 '@room' — 크루 슬러그와 불충돌), chat() 옵션 workFolder로 개인 고정을 덮는다.
//
// 잠그는 계약:
//  ① activeFolders(folder) — 등록·존재 검증을 통과한 폴더만 개인 고정을 덮는다(없는 경로를 우기지 않는다).
//  ② 회의 턴 — 발언 크루 전원(릴레이 뒤 순서 포함)의 프롬프트에 회의 폴더가 실린다: commonDirectives의
//     "지금 일할 폴더"(강제)와 트랜스크립트 아래 "작업 폴더:" 줄(맥락). 개인 고정이 달라도 회의 폴더가 이긴다.
//     가짜 codex를 PATH에 두어 CLI 분기를 실제로 돌린다(artifacts-behavior 하네스) — 프롬프트는 `--` 뒤 인자.
//  ③ 못 찾는 폴더(외장 분리·삭제)는 조용히 빼지 않고 방에 알린다 + 프롬프트에서 빠진다.
//  ④ 회의록에 작업 폴더가 남는다.
//  ⑤ 배선 — SDK 경로·재시도 재귀(실호출 불가: 자격 필요)는 구간 불변식으로, 화면 두 페이지는 공용 모듈 사용을 잠근다.
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-room-folder-'));
process.env.ARGO_ROOT = ROOT; // workspace.mjs 임포트 전 — 실데이터 미접촉
const BIN = join(ROOT, 'bin');
const CAP = join(ROOT, 'captured-prompts.txt'); // 가짜 codex가 받은 프롬프트를 턴 순서대로 append
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; P=""; after=0
for a in "$@"; do
  if [ "$after" = "1" ]; then P="$a"; after=0; fi
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  if [ "$a" = "--" ]; then after=1; fi
  prev="$a"
done
printf '\\n===TURN===\\n%s' "$P" >> "${CAP}"
[ -n "$OUT" ] && printf '알겠습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀) 우선 반전 후에도 가짜 codex가 잡히게 — 하네스 전용 해치

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createCompany, paths } = await import('../src/workspace.mjs');
const { activeFolders, setPin, updateWorkRoots, loadPins } = await import('../src/workroots.mjs');
const { runRoomTurn, loadRoom, endMeeting, roomFolder, ROOM_FOLDER_SLUG } = await import('../src/room.mjs');

const POSIX = process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false;
const BASE = await realpath(await mkdtemp(join(tmpdir(), 'argo-room-folder-dirs-'))); // canonical(macOS /var→/private/var)
const FOLDER = join(BASE, '회의폴더');
const OTHER = join(BASE, '개인폴더');
await mkdir(FOLDER); await mkdir(OTHER);

async function seed(ws) {
  await createCompany(ws, '회의폴더 테스트사', 'captain');
  const p = paths(ws);
  await writeFile(join(p.agents, 'crew-a.md'), '---\nname: 크루A\nrole: 기획\nrunner: codex\n---\n\n기획 담당.\n');
  await writeFile(join(p.agents, 'crew-b.md'), '---\nname: 크루B\nrole: 검수\nrunner: codex\n---\n\n검수 담당.\n');
  await writeFile(join(p.root, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
  await updateWorkRoots(ws, { add: FOLDER });
  await updateWorkRoots(ws, { add: OTHER });
  return p;
}
const turns = async () => (await readFile(CAP, 'utf8').catch(() => '')).split('\n===TURN===\n').filter(Boolean);
const resetCap = () => rm(CAP, { force: true });

test('① activeFolders(folder): 등록된 회의 폴더가 개인 고정을 덮고, 미등록·없는 폴더면 개인 고정으로 돌아간다', async () => {
  const ws = 'rf-active'; await seed(ws);
  await setPin(ws, 'crew-a', OTHER);
  assert.equal((await activeFolders(ws, 'crew-a')).pin, OTHER, '전제 — 회의 폴더 없으면 개인 고정');
  assert.equal((await activeFolders(ws, 'crew-a', { folder: FOLDER })).pin, FOLDER, '회의 폴더가 개인 고정을 덮는다');
  assert.equal((await activeFolders(ws, 'crew-a', { folder: FOLDER.toUpperCase() })).pin, FOLDER, '대소문자 변형도 등록 정본으로(폴딩 — activePin과 같은 잣대)');
  assert.equal((await activeFolders(ws, 'crew-b', { folder: FOLDER })).pin, FOLDER, '개인 고정이 없는 크루도 회의 폴더를 받는다');
  const stray = join(BASE, '미등록'); await mkdir(stray, { recursive: true });
  assert.equal((await activeFolders(ws, 'crew-a', { folder: stray })).pin, OTHER, '미등록 폴더는 덮지 못한다 — 등록 검증 우회 통로 금지');
  assert.equal((await activeFolders(ws, 'crew-a', { folder: join(BASE, '없음') })).pin, OTHER, '없는 경로는 덮지 못한다');
  assert.equal((await activeFolders(ws, 'crew-a', { folder: '' })).pin, OTHER, '빈 값 = 회의 폴더 없음');
});

test('② 회의 턴: 발언 크루 전원(릴레이 뒤 순서 포함)이 회의 폴더를 "지금 일할 폴더"로 받고, 개인 고정보다 회의 폴더가 이긴다', { skip: POSIX }, async () => {
  const ws = 'rf-turn'; await seed(ws); await resetCap();
  await setPin(ws, 'crew-a', OTHER);              // 크루A의 개인 고정은 다른 곳
  await setPin(ws, ROOM_FOLDER_SLUG, FOLDER);     // 회의 폴더 — 화면의 '@room' 고정과 같은 API(POST /workroots pin)
  assert.deepEqual(await roomFolder(ws), { pin: FOLDER, stale: '' });
  const r = await runRoomTurn(ws, '@crew-a > @crew-b 회의 자료를 정리해줘');
  assert.deepEqual(r.replies.map((x) => x.slug), ['crew-a', 'crew-b'], '전제 — 릴레이 두 명이 실제로 발언했다');
  const got = await turns();
  assert.equal(got.length, 2, `가짜 codex가 받은 프롬프트 수: ${got.length}`);
  for (const [i, prompt] of got.entries()) {
    assert.ok(prompt.includes(`지금 일할 폴더: ${FOLDER}`), `${i + 1}번째 발언자의 프롬프트에 회의 폴더 강제 줄이 없다`);
    assert.ok(prompt.includes(`작업 폴더: ${FOLDER} — 사장이 이 회의에 지정한 폴더다`), `${i + 1}번째 발언자의 트랜스크립트 줄이 없다`);
    assert.ok(!prompt.includes(`지금 일할 폴더: ${OTHER}`), `${i + 1}번째 발언자에게 개인 고정이 회의 폴더를 이겼다 — 발언자마다 폴더가 갈린다`);
  }
  assert.ok(got[0].includes(OTHER), '개인 고정 폴더는 "그 밖에 써도 되는 폴더"로는 남는다(등록 목록)');
  // 개인 스레드 기록(appendTurn userMsg=prompt)에도 같은 줄 — 회의에서 시킨 일을 개인 채팅에서 이어갈 때 폴더가 보인다
  const thread = JSON.parse(await readFile(join(paths(ws).chats, 'crew-b.json'), 'utf8'));
  assert.ok(JSON.stringify(thread).includes(`작업 폴더: ${FOLDER}`), '개인 스레드에 회의 폴더 줄이 없다');
  assert.ok(!(await loadRoom(ws)).messages.some((m) => m.who === 'system' && m.kind === 'folder'), '멀쩡한 폴더에 경고가 떴다');
});

test('②-b 회의 폴더가 없으면 각자 개인 고정 — 회의실이 개인 고정을 지우지 않는다(기존 행동 보존)', { skip: POSIX }, async () => {
  const ws = 'rf-none'; await seed(ws); await resetCap();
  await setPin(ws, 'crew-a', OTHER);
  await runRoomTurn(ws, '@crew-a 정리해줘');
  const [prompt] = await turns();
  assert.ok(prompt.includes(`지금 일할 폴더: ${OTHER}`), '회의 폴더가 없을 때 개인 고정이 사라졌다');
  assert.ok(!prompt.includes('작업 폴더:'), '회의 폴더가 없는데 트랜스크립트 줄이 생겼다');
});

test('③ 못 찾는 회의 폴더(삭제·외장 분리)는 방에 알리고 프롬프트에서 뺀다 — 조용히 빼면 사장은 그 폴더에서 일한 줄 안다', { skip: POSIX }, async () => {
  const ws = 'rf-stale'; await seed(ws); await resetCap();
  const gone = join(BASE, `사라질폴더-${ws}`); await mkdir(gone);
  await updateWorkRoots(ws, { add: gone });
  await setPin(ws, ROOM_FOLDER_SLUG, gone);
  await rm(gone, { recursive: true });
  assert.deepEqual(await roomFolder(ws), { pin: '', stale: gone });
  await runRoomTurn(ws, '@crew-a 정리해줘');
  const sysLines = (await loadRoom(ws)).messages.filter((m) => m.who === 'system' && m.kind === 'folder');
  assert.equal(sysLines.length, 1, '경고 시스템 줄이 정확히 하나');
  assert.ok(sysLines[0].text.includes(gone), '어느 폴더인지 이름으로 밝힌다');
  const [prompt] = await turns();
  assert.ok(!prompt.includes(gone), '없는 폴더가 프롬프트에 실렸다');
  assert.ok(!prompt.includes('작업 폴더:'), '없는 폴더의 트랜스크립트 줄이 생겼다');
  // 등록 해제도 같은 길 — updateWorkRoots(remove)가 '@room' 고정을 함께 걷는다(크루 핀과 같은 캐스케이드)
  await setPin(ws, ROOM_FOLDER_SLUG, FOLDER);
  await updateWorkRoots(ws, { remove: FOLDER });
  assert.equal((await loadPins(ws))[ROOM_FOLDER_SLUG], undefined, '등록에서 뺐는데 회의 고정이 남았다 — 재등록 때 조용히 부활');
  await updateWorkRoots(ws, { add: FOLDER });
});

test('④ 회의록에 작업 폴더가 남는다 — 회사 기억(일지)에서 "어느 폴더에서 한 회의"인지 이어진다', { skip: POSIX }, async () => {
  const ws = 'rf-minutes'; await seed(ws); await resetCap();
  await setPin(ws, ROOM_FOLDER_SLUG, FOLDER);
  await runRoomTurn(ws, '@crew-a 정리해줘');
  const r = await endMeeting(ws);
  assert.equal(r.archived, true);
  const md = await readFile(join(paths(ws).root, 'vault', r.journal), 'utf8');
  assert.match(md, new RegExp(`^참석: .*\\n작업 폴더: ${FOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), '참석 줄 아래 작업 폴더 줄');
  // 고정은 회의 마치기로 풀리지 않는다(크루 핀과 같은 "풀기 전까지 유지") — 다음 회의도 같은 폴더에서 이어진다
  assert.equal((await loadPins(ws))[ROOM_FOLDER_SLUG], FOLDER, '회의 마치기가 회의 폴더를 지웠다');
  // 폴더가 없는 회의의 회의록엔 줄이 없다
  await setPin(ws, ROOM_FOLDER_SLUG, '');
  await runRoomTurn(ws, '@crew-a 하나 더');
  const r2 = await endMeeting(ws);
  assert.doesNotMatch(await readFile(join(paths(ws).root, 'vault', r2.journal), 'utf8'), /작업 폴더:/, '폴더 없는 회의록에 빈 줄이 생겼다');
});

// ── ⑤ 배선 불변식 — 실호출 불가 구간(SDK 경로·재시도 재귀·클라이언트)을 소스 구간으로 잠근다(레포 관례: 주석 제거 후).
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const load = async (rel) => stripComments(await readFile(new URL(rel, import.meta.url), 'utf8'));

test('⑤ chat.mjs: 폴더 조회 2곳(SDK·CLI) 모두 workFolder를 넘기고, 재시도 재귀 6곳이 workFolder를 잃지 않는다', async () => {
  const src = await load('../src/chat.mjs');
  const lookups = [...src.matchAll(/activeFolders\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(lookups.length, 2, `폴더 조회가 2곳이어야 한다(러너 중립성) — 실제 ${lookups.length}`);
  for (const args of lookups) assert.match(args, /\{\s*folder:\s*workFolder\s*\}/, `이 조회가 회의 폴더를 안 넘긴다 — 이 러너 계열만 개인 고정으로 돈다: ${args}`);
  const recursions = [...src.matchAll(/await chat\(wsId, agentSlug, userMsg, [^,]+, \{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(recursions.length >= 6, `재시도 재귀 호출이 6곳 미만 — 실제 ${recursions.length}`);
  for (const opts of recursions) {
    assert.match(opts, /\bworkFolder\b/, `재시도 재귀가 workFolder를 떨어뜨린다 — 재시도 턴만 개인 고정으로 돌아간다: ${opts.slice(0, 80)}`);
    assert.doesNotMatch(opts, /workFolder\s*:\s*(''|""|null|undefined)/, `workFolder가 리터럴로 죽어 있다: ${opts.slice(0, 80)}`);
  }
  assert.match(src, /workFolder = ''/, 'chat() 서명에 workFolder 기본값');
});

test('⑤ room.mjs: 발언 호출이 workFolder=folder를 넘기고 프롬프트에 폴더 줄이 조립된다(스냅샷 1회)', async () => {
  const src = await load('../src/room.mjs');
  assert.match(src, /chat\(wsId, a\.slug, prompt, null, \{[^}]*\bworkFolder: folder\b[^}]*\}\)/, '발언 호출이 회의 폴더를 안 넘긴다');
  assert.equal((src.match(/await roomFolder\(wsId\)/g) ?? []).length, 1, '턴당 스냅샷은 정확히 한 번 — 발언자마다 다시 재면 도중 해제에 발언자별로 갈린다');
  assert.match(src, /\$\{transcript\}\$\{folderLine\}/, '트랜스크립트 바로 아래에 폴더 줄');
  assert.equal(ROOM_FOLDER_SLUG, '@room', "서버 키 '@room' — 화면(useWorkFolder slug)·초안 키와 같은 이름공간");
});

test('⑤ 화면: 회의실·크루 채팅이 같은 공용 모듈(work-folder.jsx)을 쓰고, 회의실 키는 서버와 같은 @room이다', async () => {
  const room = await load('../app/c/[ws]/room/page.jsx');
  assert.match(room, /import \{ useWorkFolder, WorkFolderPopover, WorkFolderRow, WorkFolderButton \} from '\.\.\/work-folder';/, '회의실 import');
  assert.match(room, /useWorkFolder\(\{ ws, slug: '@room'/, "회의실 고정 키 '@room'");
  assert.match(room, /\{wf\.open && !mentionOpen && <WorkFolderPopover wf=\{wf\}/, '팝오버 — 멘션 드롭업과 상호 배타');
  assert.match(room, /\{wf\.pinned && \(\s*<div className="composer-stack"[^\n]*>\s*<WorkFolderRow wf=\{wf\} \/>/, '고정 칩 — 컴포저 스택');
  assert.match(room, /<WorkFolderButton wf=\{wf\} disabled=\{busy\}/, '폴더 버튼');
  assert.match(room, /async function openSession\(id\) \{\s*wf\.close\(\);/, '열람 전환 시 팝오버 닫기(크루와 동일)');
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /import \{ useWorkFolder, WorkFolderPopover, WorkFolderRow, WorkFolderButton \} from '\.\.\/\.\.\/work-folder';/, '크루 import');
  assert.match(crew, /useWorkFolder\(\{ ws, slug, onError/, '크루 고정 키 = 슬러그');
  for (const dup of ['openFolderDialog', 'isFolderDialogBroken', 'FOLDER_DIALOG_EVENT', 'pinnedFolder', 'registerWorkFolder']) {
    assert.ok(!crew.includes(dup), `크루 페이지에 인라인 폴더 구현이 남아 있다(${dup}) — 정본이 둘로 갈린다`);
  }
  const mod = await load('../app/c/[ws]/work-folder.jsx');
  assert.match(mod, /api\(`\/api\/companies\/\$\{ws\}\/workroots`, \{ pin: \{ slug, path \} \}\)/, '고정 API — 크루 핀과 같은 라우트·바디');
  assert.match(mod, /openFolderDialog\(t\('settings\.workroots\.pickTitle'\)\)/, '데스크톱 픽커 정본(ui.jsx)');
  assert.match(mod, /catch \{ setPickerDead\(true\); \}/, '픽커 실패 → 경로 폼 폴백');
});
