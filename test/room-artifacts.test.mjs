// 회의실 산출물 바로 보기·바로 가기 — 유건 요청(2026-09-02, 회의실 개선 3/6).
// 뿌리: room.mjs가 chat() 결과의 artifacts를 **개인 스레드(appendTurn)에만** 기록하고 방 메시지(pushRoomMsg)에는
// 싣지 않았다 — 회의에서 크루가 만든 파일을 회의실에선 볼 수도(미리보기) 갈 수도(뷰어·다운로드) 없었다.
// 잠그는 것: ① 방 메시지·POST replies에 artifacts(가짜 러너 실제 실행 — 행동) ② 없으면 필드 자체가 없다(스레드 규약)
// ③ 회의록(journal md)에 산출물 줄(행동) ④ 동기화 union 병합이 필드를 보존(행동) ⑤ 화면·위임 미러 배선(소스 구간 핀 —
// JSX는 구간 불변식으로만 잠긴다·위임은 SDK 도구 경로라 가짜 러너로 못 돈다. 핀은 행동 테스트보다 약하다고 명시).
// ⚠ workspace.mjs의 WS_ROOT는 모듈 로드 시점에 고정 — env를 어떤 임포트보다 먼저 잡는다(실데이터 미접촉).
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-room-art-'));
process.env.ARGO_ROOT = ROOT;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const mkws = async (ws) => {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) {
    await mkdir(join(ROOT, ws, ...d), { recursive: true });
  }
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang: 'ko', created: new Date().toISOString() }));
  await writeFile(join(ROOT, ws, 'chats', 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
};
const seedCrew = async (ws) => {
  await writeFile(join(ROOT, ws, 'agents', 'crew-a.md'), '---\nname: 크루A\nrunner: codex\n---\n\n전문가.\n');
  await writeFile(join(ROOT, ws, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
};

// 가짜 codex — ①파일 1개 산출(워크스페이스 루트에 .fake-nofile 표지가 있으면 산출 없음) ②--output-last-message에 답변
// ③받은 프롬프트(runners.mjs가 `--` 뒤 마지막 인자로 넘긴다)를 .fake-prompts에 누적 — 뒤 크루의 트랜스크립트 검사용.
// test/artifacts-behavior.test.mjs 하네스와 같은 형태 — 벤더 CLI 없이 CLI 분기를 실제로 돈다.
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"; last="$a"
done
printf '%s\n=====\n' "$last" >> "$PWD/.fake-prompts"
if [ -f "$PWD/.fake-nofile" ]; then
  [ -n "$OUT" ] && printf '의견만 드립니다.' > "$OUT"
  exit 0
fi
mkdir -p "$PWD/vault/projects/20260902_회의"
printf '# 회의 요약\\n\\n- 결정 1' > "$PWD/vault/projects/20260902_회의/요약.md"
[ -n "$OUT" ] && printf '요약을 vault/projects/20260902_회의/요약.md 로 남겼습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀) 우선 반전 후에도 가짜 codex가 잡히게 — 하네스 전용 해치

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { runRoomTurn, loadRoom, endMeeting } = await import('../src/room.mjs');
const { loadThread } = await import('../src/thread.mjs');
const { mergeThread } = await import('../src/sync.mjs');

// 소스 핀은 주석을 벗기고 본다 — 주석 속 문구가 앵커에 걸리면 fail-open(레포 관례)
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const read = async (rel) => stripComments(await readFile(join(REPO, rel), 'utf8'));

// Windows 스킵 — 가짜 codex가 POSIX 셸 스크립트라 실행 불가(artifacts-behavior와 같은 사유). 배선은 플랫폼 무관 JS·macOS CI가 커버.
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false };
const REL = 'projects/20260902_회의/요약.md';

test('회의 턴에서 크루가 만든 파일이 방 메시지와 POST replies의 artifacts에 실린다 — 개인 스레드에만 있던 비대칭 해소', POSIX_ONLY, async () => {
  const WS = 'room-art';
  await mkws(WS); await seedCrew(WS);
  const r = await runRoomTurn(WS, '@crew-a 회의 요약 문서 만들어줘');
  assert.deepEqual(r.replies[0]?.artifacts, [REL], 'POST 응답 replies — 화면의 스냅샷 부재 폴백 경로도 칩을 잃지 않아야 한다');
  const crew = (await loadRoom(WS)).messages.find((m) => m.who === 'crew-a');
  assert.ok(crew, '크루 발언이 방에 있다');
  assert.deepEqual(crew.artifacts, [REL], '방 메시지에 artifacts — 회의실 말풍선 칩의 원천');
  // 개인 스레드 기록은 그대로다(기존 행동 유지 — 방에 싣는다고 스레드에서 빼지 않는다)
  const mine = (await loadThread(WS, 'crew-a')).messages.filter((m) => m.who === 'crew').at(-1);
  assert.deepEqual(mine?.artifacts, [REL], '개인 스레드 기록 유지');
});

test('파일을 안 만든 발언은 artifacts 필드 자체가 없다 — thread.mjs appendTurn과 같은 규약(방 스레드 비대화 방지)', POSIX_ONLY, async () => {
  const WS = 'room-noart';
  await mkws(WS); await seedCrew(WS);
  await writeFile(join(ROOT, WS, '.fake-nofile'), '');
  const r = await runRoomTurn(WS, '@crew-a 의견만 줘');
  assert.equal('artifacts' in (r.replies[0] ?? {}), false, 'replies에도 빈 배열을 싣지 않는다');
  const crew = (await loadRoom(WS)).messages.find((m) => m.who === 'crew-a');
  assert.ok(crew, '크루 발언이 방에 있다');
  assert.equal('artifacts' in crew, false, '빈 배열이 아니라 필드 부재');
});

test('회의록(journal md)에 산출물 줄이 남는다 — 회의에서 만든 파일이 회사 기억에서도 이어진다(첨부 줄과 같은 vault/ 경로 규약)', async () => {
  const WS = 'room-journal';
  await mkws(WS);
  await writeFile(join(ROOT, WS, 'chats', 'room-main.json'), JSON.stringify({ messages: [
    { who: 'user', text: '@crew-a 요약 문서', ts: 1 },
    { who: 'crew-a', text: '남겼습니다', ts: 2, artifacts: [REL, 'files/표.csv'] },
    { who: 'crew-a', text: '의견만 보탭니다', ts: 3 },
  ], sid: 1 }));
  const r = await endMeeting(WS);
  assert.equal(r.archived, true);
  const md = await readFile(join(ROOT, WS, 'vault', r.journal), 'utf8');
  assert.match(md, /\n> 산출물: vault\/projects\/20260902_회의\/요약\.md, vault\/files\/표\.csv\n/, '산출물 줄 — vault/ 접두(첨부 줄·트랜스크립트 경로 노트와 동일 규약)');
  assert.equal((md.match(/> 산출물:/g) ?? []).length, 1, '산출물 없는 발언에는 줄이 붙지 않는다');
});

test('동기화 union 병합이 방 메시지의 artifacts를 보존한다 — 다른 기기에서 열어도 칩이 산다', () => {
  const L = { messages: [{ who: 'user', text: '안건', ts: 1 }, { who: 'crew-a', text: '남겼습니다', ts: 2, artifacts: [REL] }], sid: 1 };
  const R = { messages: [{ who: 'user', text: '안건', ts: 1 }], sid: 1 };
  for (const prefer of ['remote', 'local']) {
    const out = JSON.parse(mergeThread(Buffer.from(JSON.stringify(L)), Buffer.from(JSON.stringify(R)), prefer).toString('utf8'));
    assert.deepEqual(out.messages.find((m) => m.who === 'crew-a')?.artifacts, [REL], `prefer=${prefer}: 메시지는 통째로 보존돼야 한다(필드 투영 금지)`);
  }
});

test('화면 배선 — 회의실 크루 말풍선이 공용 ArtifactChips를 그리고, 크루 페이지도 같은 모듈을 쓴다(사본 0) [소스 구간 핀]', async () => {
  const room = await read('app/c/[ws]/room/page.jsx');
  assert.match(room, /^import \{ ArtifactChips \} from '\.\.\/artifact-chips';$/m, '회의실 임포트');
  // 크루 발언 분기 구간 — 본문(Markdown) 줄부터 진행 표시 줄 전까지. 이 안에 칩이 있어야 같은 말풍선 컨테이너다.
  const i = room.indexOf('<Markdown text={m.text} wsId={ws} />');
  assert.ok(i > 0, '크루 본문 앵커(vault-links 테스트와 같은 앵커)');
  const j = room.indexOf('{!viewing && (busy || serverBusy)', i);
  assert.ok(j > i, '진행 표시 앵커');
  // 본문 </div> 바로 다음(공백·빈 JSX 주석 자리만 허용) — `{null && <>…</>}`·`{viewing && …}` 감싸기 변이가 부분 매칭으로
  // 초록이던 구멍(분리 검수 LOW-1 프로브)을 인접성으로 닫는다. stripComments는 주석 문자를 공백으로 바꿔 `{   }`가 남는다.
  assert.match(room.slice(i, j), /<\/div>\n(?:\s|\{\s*\})*\{m\.artifacts\?\.length > 0 && <ArtifactChips ws=\{ws\} rels=\{m\.artifacts\} \/>\}/,
    '크루 말풍선 본문 바로 아래에 산출물 칩(조건은 m.artifacts만) — 없으면 방 메시지에 실은 artifacts가 화면에 안 나온다');
  // POST 응답 폴백(스냅샷 부재) 소비자 — 서버가 replies에 실어도 여기서 버리면 죽은 계약(분리 검수 MEDIUM-1)
  const s0 = room.indexOf('async function send(e)'); const s1 = room.indexOf('async function endMeeting', s0);
  assert.ok(s0 > 0 && s1 > s0, 'send 구간');
  assert.match(room.slice(s0, s1), /d\.replies\.map\(\(r\) => \(\{ who: r\.slug, text: r\.reply, ts: Date\.now\(\), \.\.\.\(r\.artifacts\?\.length \? \{ artifacts: r\.artifacts \} : \{\}\) \}\)\)/,
    '폴백 map이 replies의 artifacts를 옮긴다');
  const crew = await read('app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /^import \{ ArtifactChips \} from '\.\.\/\.\.\/artifact-chips';$/m, '크루 페이지 임포트');
  assert.doesNotMatch(crew, /function ArtifactChips\(|function ArtifactPreview\(/, '크루 페이지에 사본이 남으면 두 화면의 열람 계약이 갈린다');
  assert.match(crew, /\{m\.artifacts\?\.length > 0 && <ArtifactChips ws=\{ws\} rels=\{m\.artifacts\} \/>\}/, '크루 채팅의 칩 렌더 유지(이관으로 소실 금지) — 조건까지 폐합(`{false && …}` 변이 초록 방지)');
  const shared = await read('app/c/[ws]/artifact-chips.jsx');
  assert.match(shared, /^export function ArtifactChips\(\{ ws, rels \}\)/m, '공용 모듈이 export');
});

test('위임 미러 배선 — chat.mjs delegate 이벤트가 artifacts를 싣고, room.mjs 미러가 방 메시지에 옮긴다 [소스 구간 핀 — 위임 실행은 SDK 도구 경로라 가짜 러너로 못 돈다]', async () => {
  const chat = await read('src/chat.mjs');
  const em = chat.match(/emitNotify\(\{ type: 'delegate',[^\n]*?\}\);/g) ?? [];
  assert.equal(em.length, 1, 'delegate 이벤트 발행 지점은 1곳');
  // 뒤 토큰(ctx)까지 폐합 — `r.artifacts?.slice(0, 0)`·`r.artifacts && undefined` 같은 값 비우기 변이가 초록이던 구멍(검수 LOW-1)
  assert.match(em[0], /\breply: r\.reply, artifacts: r\.artifacts, ctx: mirrorCtx \}\);/, '이벤트에 artifacts 원값 — 없으면 위임받은 크루가 만든 파일이 방에서 칩 없이 온다');
  const room = await read('src/room.mjs');
  const i = room.indexOf('for (const ev of mirrored)');
  assert.ok(i > 0, '미러 루프 앵커');
  const j = room.indexOf('if (!live) return', i);
  assert.ok(j > i);
  assert.match(room.slice(i, j), /\.\.\.\(ev\.artifacts\?\.length \? \{ artifacts: ev\.artifacts \} : \{\}\)/, '미러 메시지에 artifacts(빈 배열은 싣지 않는 규약 포함)');
});

// ── 트랜스크립트 산출물 노트(검수 LOW-2 이월) — 뒤 크루가 앞 크루의 파일 경로를 답변 텍스트가 아니라 노트로 받는다.
const promptsOf = async (ws) => (await readFile(join(ROOT, ws, '.fake-prompts'), 'utf8')).split('\n=====\n').filter(Boolean);

test('릴레이(@B > @A) 실제 실행: 앞 크루의 산출물 경로가 뒤 크루 프롬프트 트랜스크립트에 노트로 실린다', POSIX_ONLY, async () => {
  const WS = 'room-relay-note';
  await mkws(WS); await seedCrew(WS);
  await writeFile(join(ROOT, WS, 'agents', 'crew-b.md'), '---\nname: 크루B\nrunner: codex\n---\n\n전문가.\n');
  const r = await runRoomTurn(WS, '@crew-b > @crew-a 회의 요약 문서를 만들고 이어서 검토해줘');
  assert.deepEqual(r.replies.map((x) => x.slug), ['crew-b', 'crew-a'], '릴레이 순서');
  const prompts = await promptsOf(WS);
  assert.equal(prompts.length, 2, '가짜 codex가 크루B → 크루A 순으로 두 번 호출됐다');
  assert.doesNotMatch(prompts[0], /\(산출물, Read로 열람/, '첫 발언자 시점엔 방에 산출물이 없다');
  assert.match(prompts[1], /크루B: 요약을 vault\/projects\/20260902_회의\/요약\.md 로 남겼습니다\. \(산출물, Read로 열람: vault\/projects\/20260902_회의\/요약\.md\)/,
    '앞 크루 발언 줄 끝에 산출물 노트 — vault/ 접두(첨부 노트·회의록 줄과 같은 규약)');
});

test('첨부와 산출물이 같은 발언에 있으면 노트가 첨부 → 산출물 순으로 나란히 붙는다(시드 방)', POSIX_ONLY, async () => {
  const WS = 'room-note-order';
  await mkws(WS); await seedCrew(WS);
  await writeFile(join(ROOT, WS, 'agents', 'crew-b.md'), '---\nname: 크루B\nrunner: codex\n---\n\n전문가.\n'); // 이름 표기(nameOf)까지 고정 — slug 폴백에 기대지 않는다(검수 LOW-3)
  // 본문은 400자 잘림 상한을 넘기게 — 노트가 잘림 **바깥**에 붙는다는 속성을 잠근다(검수 LOW-1: 짧은 시드면
  // `String(m.text + note).slice(0, 400)` 변이도 초록). 8자 + 가×450 → 잘린 본문 = 8자 + 가×392.
  const longText = '정리했습니다. ' + '가'.repeat(450);
  await writeFile(join(ROOT, WS, 'chats', 'room-main.json'), JSON.stringify({ messages: [
    { who: 'user', text: '@crew-b 정리해줘', ts: 1, attachments: [{ rel: 'files/a1_스케치.png', name: '스케치.png', isImage: true }] },
    { who: 'crew-b', text: longText, ts: 2, attachments: [{ rel: 'files/a1_스케치.png', name: '스케치.png' }], artifacts: [REL, 'files/표.csv'] },
  ], sid: 1 }));
  await runRoomTurn(WS, '@crew-a 이어서 검토해줘');
  const [p] = await promptsOf(WS);
  assert.match(p, /크루B: 정리했습니다\. 가{392} \(첨부, Read로 열람: vault\/files\/a1_스케치\.png\) \(산출물, Read로 열람: vault\/projects\/20260902_회의\/요약\.md, vault\/files\/표\.csv\)\n/,
    '본문은 400자에서 잘리고 그 뒤에 첨부 노트 → 산출물 노트가 잘리지 않고 붙는다, 복수 경로는 쉼표 나열, 줄 끝');
  assert.doesNotMatch(p, /가{393}/, '본문 잘림(400) 유지 — 노트를 넣으며 잘림을 풀지 않았다');
  assert.match(p, /사장: @crew-b 정리해줘 \(첨부, Read로 열람: vault\/files\/a1_스케치\.png\)\n/, '사장 줄의 첨부 노트는 그대로(회귀 없음)');
});
