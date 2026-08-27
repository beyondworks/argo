// 채널별 알림 선택 — 실사용 신고(2026-07-31): 루틴 프롬프트에서 텔레그램 지시를 지우고 크루에게도
// "보내지 말라"고 했는데 루틴 결과가 계속 텔레그램으로 갔다. 크루도 원인을 몰랐는데, 보내는 주체가
// 크루가 아니라 **게이트웨이 계층**이었고 끌 수단이 없었다(연결 자체를 끊는 것 말고는).
//
// 여기서 잠그는 계약:
//  ① 기본값(설정 없음·빈 배열) = 지금까지와 동일하게 전부 보낸다 — 기존 사용자 무영향.
//  ② mutedEvents에 든 종류만 그 채널로 안 간다. 다른 종류·다른 채널은 그대로.
//  ③ 저장은 목록 밖 값·중복을 걸러 정규화한다(끈 목록이 쓰레기로 커지지 않게).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-mute-')); // import보다 먼저
const { CHANNEL_EVENTS, normalizeMuted, channelSends } = await import('../src/channel-events.mjs');
const { loadConnections, updateConnection, CONNECTION_PATCH_FIELDS } = await import('../src/connections.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'co-mute';
await createCompany(WS, '알림선택 테스트사', 'captain');

test('기본값 — 설정한 적 없으면 빈 배열(= 전부 보냄, 기존 동작 그대로)', async () => {
  const c = await loadConnections(WS);
  assert.deepEqual(c.telegram.mutedEvents, []);
  assert.deepEqual(c.slack.mutedEvents, []);
});

test('저장 정규화 — 목록 밖 값·중복은 걸러진다', () => {
  // 정렬해 저장한다 — 같은 선택이 클릭 순서에 따라 두 모양이면 동기화 diff에 의미 없는 변경이 남는다.
  assert.deepEqual(normalizeMuted('telegram', ['routine', 'routine', 'job']), ['job', 'routine']);
  assert.deepEqual(normalizeMuted('telegram', ['routine', '없는종류', 42, null]), ['routine']);
  // 슬랙은 문안이 준비된 2종만 보낸다 — 보내지도 않는 종류를 끈 목록에 담아둘 이유가 없다.
  assert.deepEqual(normalizeMuted('slack', ['routine', 'crewmail']), ['routine']);
  assert.deepEqual(normalizeMuted('telegram', 'routine'), [], '배열이 아니면 빈 목록');
});

test('저장 — 끈 목록이 영속되고, 다른 필드를 건드리지 않는다', async () => {
  await updateConnection(WS, 'telegram', { token: 'probe-token-1', defaultCrew: 'captain' });
  await updateConnection(WS, 'telegram', { mutedEvents: ['routine', '없는것'] });
  const c = await loadConnections(WS);
  assert.deepEqual(c.telegram.mutedEvents, ['routine'], '정규화되어 저장');
  assert.equal(c.telegram.token, 'probe-token-1', '알림 선택만 바꿔도 토큰이 유지된다');
  assert.equal(c.telegram.defaultCrew, 'captain');
  assert.deepEqual((await loadConnections(WS)).slack.mutedEvents, [], '다른 채널은 무관');
});

test('발송 판정 — 게이트웨이가 실제로 쓰는 그 함수를 검증한다(사본 금지)', () => {
  // 규칙을 여기서 다시 선언하면 게이트웨이가 드리프트해도 이 테스트는 자기 사본을 재서 초록이다.
  // 그때 조용히 재발하는 것이 이 기능이 고친 신고라, 판정은 반드시 공유 함수를 부른다.
  const ch = { enabled: true, mutedEvents: ['routine'] };
  assert.equal(channelSends('telegram', ch, 'routine'), false, '끈 종류는 안 보낸다');
  assert.equal(channelSends('telegram', ch, 'approval'), true, '나머지는 그대로 — 결재 알림까지 죽이지 않는다');
  assert.equal(channelSends('telegram', ch, 'job'), true);
  assert.equal(channelSends('telegram', { enabled: true }, 'routine'), true, '설정 없음 = 기존 동작(전부 보냄)');
  assert.equal(channelSends('telegram', { enabled: false, mutedEvents: [] }, 'approval'), false, '연결이 꺼져 있으면 아무것도 안 보낸다');
  // 채널이 애초에 안 보내는 종류 — 슬랙엔 작업완료·쪽지 문안이 없다. 목록이 곧 게이트다.
  assert.equal(channelSends('slack', { enabled: true }, 'job'), false);
  assert.equal(channelSends('slack', { enabled: true }, 'routine'), true);
});

test('채널별 종류 목록 — 화면과 저장이 같은 출처를 쓴다', () => {
  // 갈라지면 화면에 뜬 체크박스를 꺼도 저장에서 걸러져 "꺼지지 않는" 항목이 생긴다.
  assert.deepEqual([...CHANNEL_EVENTS.telegram], ['approval', 'routine', 'job', 'crewmail', 'inbox']);
  assert.deepEqual([...CHANNEL_EVENTS.slack], ['approval', 'routine']);
  for (const kind of Object.keys(CHANNEL_EVENTS)) {
    for (const ev of CHANNEL_EVENTS[kind]) {
      assert.deepEqual(normalizeMuted(kind, [ev]), [ev], `${kind}/${ev}는 저장에서 살아남아야 한다`);
    }
  }
});

test('전송 계층 — 화면이 보낸 알림 선택이 서버 허용 필드에 실제로 들어 있다', () => {
  // 분리 검수 실측: 라우트 허용 목록에서 'mutedEvents' 한 토큰을 지우자 서버가 그 필드를 조용히 버리는데
  // **전 스위트가 초록**이었다. 화면은 꺼진 것처럼 보이고 200이 오고 디스크만 그대로 → 신고 그대로 재현.
  // 라우트는 next/headers를 끌어 순수 Node로 못 부르니, 목록을 저장 모듈로 올려 여기서 잠근다.
  assert.ok(CONNECTION_PATCH_FIELDS.includes('mutedEvents'), '알림 선택이 서버에서 버려진다');
  const src = readFileSync(new URL('../app/api/companies/[ws]/connections/route.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const k of CONNECTION_PATCH_FIELDS\)/, '라우트가 정본 목록을 안 쓴다 — 인라인 목록은 조용히 낡는다');
});

test('알림 종류 라벨이 ko·en 둘 다 있다 — 종류가 늘어도 키 문자열이 출고되지 않게', () => {
  // 이 라벨들은 t(`settings.conn.ev.${ev}`)로 조립돼 i18n 트립와이어(정적 키 스캔) 밖에 있다.
  // 종류를 목록에만 추가하면 화면에 'settings.conn.ev.inbox'가 그대로 뜬다(2026-07-28 실사고 계열).
  const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const kind of Object.keys(CHANNEL_EVENTS)) {
    for (const ev of CHANNEL_EVENTS[kind]) {
      assert.match(dict, new RegExp(`'settings\\.conn\\.ev\\.${ev}': \\['[^']+', '[^']+'\\]`), `${ev} 라벨이 ko·en 둘 다 없다`);
    }
  }
});

test('배선 — 결재·슬랙은 블록 머리 판정, 브리핑 3종은 telegramBriefingDest 단일 판정을 지난다', () => {
  // 판정 함수가 옳아도 게이트웨이가 안 부르면 아무 소용이 없다(변이 실측: 호출을 지워도 전 스위트 초록).
  // 그리고 **머리에서 한 번**이 중요하다 — 분기마다 되풀이하면 새 종류를 추가할 때 빠뜨리기 쉽고,
  // 그러면 못 끄는 것은 물론 꺼진 채널로도 나간다(원래 있던 enabled 보증이 그렇게 유실됐었다).
  const g = readFileSync(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  assert.match(g, /import \{ channelSends \}/, '판정 정본을 임포트하지 않는다 — 규칙 사본이 생겼다');
  assert.match(g, /if \(t\.token && t\.chatId && sends\('telegram', t\)\)/, '텔레그램 블록 머리에 채널 판정이 없다');
  assert.match(g, /if \(s\.token && s\.channel && sends\('slack', s\)\)/, '슬랙 블록 머리에 채널 판정이 없다');
  // 받은 서류함은 알림 버스(onNotify)가 아니라 감시자가 직접 보낸다 — 목록에 있는 이상 게이트도 지나야
  // "전부 껐는데 파일 넣으니 알림이 온다"가 안 생긴다(분리 검수 지적 2026-07-31).
  assert.match(g, /channelSends\('telegram', cfg, 'inbox'\)/, '받은 서류함 푸시가 판정을 안 지난다');
  // 브리핑 3종(routine·job·crewmail)은 목적지 판정이 telegramBriefingDest(정본·순수)로 단일화됐다 —
  // 내부에서 channelSends를 부르므로 음소거 계약은 유지되고, 게이트웨이가 못 보내면 담당 크루의
  // 직통 봇으로 폴백한다(실사용 2026-08-27: 게이트웨이 꺼짐 + 직통 봇만 페어링 → 루틴 무배달).
  // 폴백의 음소거 존중은 gateway-protocol.test.mjs가 행동으로 잠근다.
  assert.match(g, /telegramBriefingDest\(t, event\.type/, '브리핑 목적지 판정(직통 봇 폴백)이 배선되지 않았다');
  // (분기별 재판정을 막는 단언은 뒀다가 지웠다 — sends는 2인자(kind, ch)고 종류는 event.type을 캡처하므로
  //  분기마다 다른 종류를 재판정하려면 시그니처부터 바꿔야 하고, 그러면 위 두 단언이 먼저 깨진다.
  //  표현 불가능한 형태를 막는 정규식은 게이트처럼 보이지만 아무것도 안 문다 — 분리 검수 실측.)
});
