// 크루 slug 예약어 — PR #393 분리 검수 LOW-6. 회의록 chats/room-main.json·회의 턴 마커 슬러그 'room-main'(room.mjs)은
// 크루 스레드 chats/<slug>.json·상태 파일 chats/<slug>.status.json과 같은 이름공간인데, slugify('Room Main')='room-main'이
// SLUG_RE를 통과해 그 크루의 스레드가 회의록을, 상태 파일이 회의 마커를 덮었다. 처방 = 예약어 원천(slug.mjs) 하나를
// 영입 문(persona.createAgentFromPrompt — UI 영입·결재 영입이 모두 이 함수로 모인다)과 반입 문(sync.EXCLUDE)이 본다.
// 잠그는 것: ① 예약어 판정 + 회의실 상수·프리셋 slug가 그 집합과 정합 ② 영입 실호출(가짜 codex)이 거절하고 카드를 남기지
// 않는다(이름 경로·frontmatter slug 경로·회사 언어 ko/en) ③ 영입 라우트 실호출이 400+errorCode ④ 반입 문 판정(인접 대조군 포함 — 실행 검증은 sync-integration RS1).
import { mkdtemp, mkdir, writeFile, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-slug-reserved-'));
process.env.ARGO_ROOT = ROOT; // workspace.mjs 임포트 전 — 실데이터 미접촉
delete process.env.NEXT_PUBLIC_SUPABASE_URL; // AUTH off — 라우트 실호출이 guardCompany를 지나게(apimsg 테스트 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

// 가짜 codex — 카드 본문은 ARGO_FAKE_CARD 파일을 그대로 --output-last-message에 쓴다(artifacts-behavior 하네스 이식).
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"
done
[ -n "$OUT" ] && cat "$ARGO_FAKE_CARD" > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀) 우선 반전 후에도 가짜 codex가 잡히게 — 하네스 전용 해치
const CARD = join(ROOT, 'card.md');
process.env.ARGO_FAKE_CARD = CARD;
const setCard = (name, slugLine = '') => writeFile(CARD, `---\nname: ${name}\n${slugLine}role: 회의 진행\n---\n\n# ${name} — 회의 진행\n\n## 전문성\n- 회의\n`);

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { isReservedSlug, RESERVED_SLUG_RE, collidesWithRoom, ROOM_FILE_SLUG } = await import('../src/slug.mjs');
const { createAgentFromPrompt } = await import('../src/persona.mjs');
const { ROOM_TURN_SLUG } = await import('../src/room.mjs');
const { PRESETS, PRESETS_EN } = await import('../src/presets.mjs');
const { EXCLUDE, isRoomCardRel } = await import('../src/sync.mjs');
const { paths } = await import('../src/workspace.mjs');

const mkws = async (ws, lang) => {
  await mkdir(paths(ws).agents, { recursive: true });
  await mkdir(paths(ws).chats, { recursive: true });
  await writeFile(paths(ws).company, JSON.stringify({ id: ws, name: 'T', owner: 'me', lang, created: new Date().toISOString() }));
  await writeFile(join(paths(ws).root, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
};
const cards = async (ws) => (await readdir(paths(ws).agents)).filter((n) => n.endsWith('.md')).sort();
const POSIX = process.platform === 'win32' ? 'POSIX 셸 하네스 — 실호출 검증은 macOS CI가 담당(판정·제외 테스트는 전 플랫폼)' : false;

test('예약어 판정 — room- 접두만 막고 room·roommate·중간 포함은 크루 이름으로 남긴다', () => {
  for (const s of ['room-main', 'room-main-2', 'room-x']) assert.equal(isReservedSlug(s), true, s);
  for (const s of ['room', 'roommate', 'my-room-main', 'pepper', '', undefined, null]) assert.equal(isReservedSlug(s), false, String(s));
  assert.equal(RESERVED_SLUG_RE.test('ROOM-main'), false, '슬러그는 항상 소문자 — 대문자 판정은 호출부(slugify) 책임');
});

test('정합 — 회의실 턴 마커 슬러그는 예약어 안, 프리셋 크루 slug는 예약어 밖', () => {
  assert.equal(isReservedSlug(ROOM_TURN_SLUG), true, `room.mjs ROOM_TURN_SLUG=${ROOM_TURN_SLUG}가 예약어 밖이면 게이트가 보호하는 이름이 아니다`);
  assert.equal(ROOM_TURN_SLUG, ROOM_FILE_SLUG, '회의 마커 슬러그 = 반입 문이 지키는 회의록 파일 이름(slug.mjs ROOM_FILE_SLUG) — 어긋나면 반입 문이 다른 파일을 지킨다');
  assert.equal(ROOM_FILE_SLUG, 'room-main', '회의록 파일(chats/room-main.json)과 같은 이름 — 바뀌면 room.mjs와 함께 본다');
  for (const P of [PRESETS, PRESETS_EN]) for (const k of Object.keys(P)) for (const c of P[k].crews) {
    assert.equal(isReservedSlug(c[1]), false, `프리셋 ${k}의 크루 slug ${c[1]}이 예약어라면 온보딩이 회의록을 덮는 크루를 심는다`);
  }
});

test('영입 실호출 — 이름 "Room Main"은 거절(code SLUG_RESERVED·회사 언어 ko)하고 카드를 남기지 않는다', { skip: POSIX }, async () => {
  const WS = 'res-ko';
  await mkws(WS, 'ko');
  await setCard('Room Main');
  await assert.rejects(createAgentFromPrompt(WS, '회의 진행 담당', { name: 'Room Main' }), (e) => {
    assert.equal(e.code, 'SLUG_RESERVED');
    assert.match(e.message, /"Room Main"\(room-main\)/);
    assert.match(e.message, /회의실 내부 이름/);
    assert.doesNotMatch(e.message, /[A-Za-z]{4,} (the|with) /, 'ko 회사는 ko 문구');
    return true;
  });
  assert.deepEqual(await cards(WS), [], 'room-main.md도 room-main-2.md도 생기지 않는다');
  assert.equal(existsSync(paths(WS).usage), false, '이름 지정 영입은 모델 턴 전에 거절 — hire usage가 적립되지 않는다(비용·5분 대기 없음)');
  // 대조군 — 인접 행동: 예약어 밖 이름은 그대로 영입된다(게이트가 영입 문 자체를 막지 않는다)
  await setCard('Pepper');
  const ok = await createAgentFromPrompt(WS, '회의 진행 담당', { name: 'Pepper' });
  assert.equal(ok.slug, 'pepper');
  assert.deepEqual(await cards(WS), ['pepper.md']);
});

test('영입 실호출 — frontmatter slug: room-main 경로(이름은 무해)도 같은 문에서 거절, en 회사는 en 문구', { skip: POSIX }, async () => {
  const WS = 'res-en';
  await mkws(WS, 'en');
  await setCard('Pepper', 'slug: room-main\n');
  await assert.rejects(createAgentFromPrompt(WS, 'meeting facilitator', { name: 'Pepper' }), (e) => {
    assert.equal(e.code, 'SLUG_RESERVED');
    assert.match(e.message, /"Pepper" \(room-main\)/);
    assert.match(e.message, /meeting room's internal name/);
    assert.doesNotMatch(e.message, /[가-힣]/, 'en 회사는 무한글');
    return true;
  });
  assert.deepEqual(await cards(WS), []);
  assert.equal(existsSync(paths(WS).usage), true, '대조군 — frontmatter slug 경로는 모델 턴 뒤 사후 게이트라 usage는 남는다');
});

test('영입 라우트 실호출 — 예약 slug는 400 + errorCode crew_slug_reserved(500 아님)', { skip: POSIX }, async () => {
  const WS = 'res-route';
  await mkws(WS, 'ko');
  await setCard('Room Main');
  const { POST } = await import('../app/api/companies/[ws]/agents/route.js');
  const req = new Request(`http://localhost/api/companies/${WS}/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '회의 진행 담당', name: 'Room Main' }),
  });
  const res = await POST(req, { params: Promise.resolve({ ws: WS }) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.errorCode, 'crew_slug_reserved');
  assert.match(body.error, /회의실 내부 이름/);
  assert.deepEqual(await cards(WS), []);
});

test('반입 문 판정 — 세척 후 room-main이 되는 카드만 불가시(별칭 포함), 접두 room-*·회의록·보관함은 대조군으로 동기화 유지', () => {
  assert.equal(collidesWithRoom('room-main'), true);
  assert.equal(collidesWithRoom('Zroom-main'), true, '별칭 — thread/turn-status가 [^a-z0-9-]를 깎아 같은 파일 chats/room-main.json이 된다(검수 MEDIUM-2)');
  assert.equal(collidesWithRoom('room_main'), false, '세척하면 roommain — 다른 파일');
  assert.equal(isRoomCardRel('agents/room-main.md'), true);
  assert.equal(isRoomCardRel('agents/Zroom-main.md'), true);
  assert.equal(isRoomCardRel('agents/room-main-2.md'), false, '접두만 겹치는 카드는 파일 충돌이 아니다 — 영입 문은 막되 반입은 끊지 않는다(검수 MEDIUM-1)');
  assert.equal(isRoomCardRel('agents/room-service.md'), false, '기존 정상 크루의 동기화를 조용히 끊지 않는다');
  assert.equal(isRoomCardRel('agents/pepper.md'), false, '대조군 — 일반 크루 카드는 동기화 대상');
  assert.equal(isRoomCardRel('agents/.archive/1725000000000-room-main.md'), false, '대조군 — 보관함(해고본)은 살아 있는 slug가 아니다');
  assert.equal(isRoomCardRel('chats/room-main.json'), false, '인접 행동 핀 — 회의록 자체는 동기화 대상(예약어가 회의록을 끊으면 회귀)');
  assert.equal(EXCLUDE('agents/room-main.md'), false, '불가시는 EXCLUDE가 아니다 — EXCLUDE 전환은 원격 잔재를 삭제해 옛 기기 카드를 지운다(sync.mjs 주석)');
});
