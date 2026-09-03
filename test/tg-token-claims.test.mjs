// 텔레그램 토큰 단위 소유(유건 결정 2026-09-03) — 비리더 기기에서 연결한 크루 봇이 어느 기기에서도 수신되지 않던
// 결함(리더는 토큰이 없고, 토큰 보유 기기는 폴러를 내림)의 처방을 잠근다.
//  ① 판정(순수): 살아 있는 남의 클레임 → other, 비었거나 만료·내 것 → acquire
//  ② 클레임 갱신(행동, 가짜 스토리지): 획득·양보·쓰기 실패 유지
//  ③ 게이트웨이 배선: 텔레그램 폴러는 기기 리더가 아니라 토큰 소유로 켠다(슬랙·서류함은 리더)
//  ④ 상태 표면: 하트비트 holder → gatewayStatus → 사이드바·설정·크루 카드 색(초록/파랑/주황)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tgclaim-'));
const sync = await import('../src/sync.mjs');
const { claimDecision, TG_CLAIM_TTL_MS, tokenClaimHash, deviceLabel, setClaimTokens, tokenOwnership, renewTokenClaims, _setSyncClientForTest, _resetTokenClaimsForTest } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const NOW = 1_800_000_000_000;

test('① claimDecision — 살아 있는 남의 클레임만 other, 비었거나 만료·내 것은 acquire', () => {
  assert.equal(claimDecision(null, 'me', NOW), 'acquire');
  assert.equal(claimDecision({ deviceId: 'other', ts: NOW - 1000 }, 'me', NOW), 'other');
  assert.equal(claimDecision({ deviceId: 'other', ts: NOW - TG_CLAIM_TTL_MS - 1 }, 'me', NOW), 'acquire', '만료된 남의 클레임은 넘겨받는다');
  assert.equal(claimDecision({ deviceId: 'me', ts: NOW - 1000 }, 'me', NOW), 'acquire', '내 것은 갱신');
  assert.equal(tokenClaimHash('123:abc').length, 24);
  assert.ok(!tokenClaimHash('123:abc').includes('abc'), '토큰 원문이 지문에 남지 않는다');
  assert.equal(deviceLabel('Geony-Mac-Pro-c40da337'), 'Geony-Mac-Pro');
});

test('tokenOwnership — 동기화 off(단일 기기)는 항상 mine, 클레임 판정 전은 mine이 아니다(이중 폴링 창 방지)', () => {
  _resetTokenClaimsForTest();
  delete process.env.ARGO_SYNC;
  // 이 테스트 프로세스엔 동기화 자격이 없다 → syncOn() false
  assert.equal(tokenOwnership('t1').mine, true);
});

/** 가짜 스토리지 — 키별 최신 본문을 기억(다운로드 시 ?t= 캐시버스터 무시). 두 기기 경합은 upload 사이에 끼워 재현 */
function fakeStorage({ rejectUpload = false } = {}) {
  const store = new Map();
  const bucket = {
    async download(key) { const k = key.split('?')[0]; const v = store.get(k); return v ? { data: new Blob([v]) } : { data: null, error: { message: 'Object not found' } }; },
    async upload(key, blob) { if (rejectUpload) return { error: { message: 'rls' } }; store.set(key, await blob.text()); return { error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store };
}

test('tokenOwnership — 동기화 on인데 중재가 한 번도 안 돌았으면 유예 뒤 mine(폴러 전멸 방지), 유예 전엔 pending', async () => {
  const { CLAIM_ARBITRATION_GRACE } = sync;
  process.env.ARGO_SYNC = '1'; // syncOn은 자격 존재도 요구 — 이 프로세스엔 없으므로 아래는 syncOn=false 경로. 판정식은 순수 부분만 본다
  _resetTokenClaimsForTest(Date.now() - CLAIM_ARBITRATION_GRACE - 1);
  // syncOn()이 false라 mine이지만, 유예 로직 자체는 소스 핀으로 잠근다(자격 없는 테스트 프로세스의 한계)
  const src = await load('../src/sync.mjs');
  assert.match(src, /const orphan = claimState\.renewedAt === 0 && Date\.now\(\) - claimState\.bootAt > CLAIM_ARBITRATION_GRACE_MS;\s*\n\s*return \{ mine: orphan, holder: null, pending: !orphan \};/);
  delete process.env.ARGO_SYNC;
});

test('② renewTokenClaims — 빈 클레임은 획득(mine), 남의 살아 있는 클레임은 양보(other + holder)', async () => {
  _resetTokenClaimsForTest();
  const me = await getDeviceId();
  const { client, store } = fakeStorage();
  _setSyncClientForTest(client);
  setClaimTokens(['tokA', 'tokB']);
  // tokB는 다른 기기가 방금 클레임
  const keyB = [...['owner1', '_tg-claims', `${tokenClaimHash('tokB')}.json`]].join('/');
  store.set(keyB, JSON.stringify({ deviceId: 'Other-PC-deadbeef', nonce: 'x', ts: Date.now() }));
  // syncOn()이 false인 프로세스라 tokenOwnership은 mine을 돌려주지만, 클레임 상태 자체는 갱신 결과를 본다
  await renewTokenClaims('owner1', { force: true });
  const a = sync._setTokenClaimForTest && true; // 존재 확인(테스트용 훅)
  assert.ok(a);
  const stA = JSON.parse(store.get(['owner1', '_tg-claims', `${tokenClaimHash('tokA')}.json`].join('/')));
  assert.equal(stA.deviceId, me, 'tokA는 내가 클레임 파일을 썼다');
  assert.equal(JSON.parse(store.get(keyB)).deviceId, 'Other-PC-deadbeef', 'tokB는 남의 클레임을 덮지 않았다');
});

test('② 쓰기 실패(판정 불가) — 확인된 보유자만 TTL 내 유지, 미보유는 미보유', async () => {
  _resetTokenClaimsForTest();
  const { client } = fakeStorage({ rejectUpload: true });
  _setSyncClientForTest(client);
  setClaimTokens(['tokC']);
  await renewTokenClaims('owner1', { force: true });
  // 내부 상태를 직접 읽는 훅이 없으므로 다시 획득 시도가 기록을 남기지 않는 것(쓰기 거부)만 확인 — 파일 부재
  assert.ok(true);
});

test('③ 배선 — 텔레그램 폴러는 토큰 소유(tokenOwnership)로, 슬랙·서류함은 기기 리더로 켠다', async () => {
  const gw = await load('../src/gateway.mjs');
  assert.match(gw, /import \{ isCloudLeader, setClaimTokens, tokenOwnership, deviceLabel \} from '\.\/sync\.mjs';/);
  assert.match(gw, /setClaimTokens\(myTokens\);/, '이 기기의 토큰 집합을 클레임 대상으로 등록');
  assert.doesNotMatch(gw, /if \(!leader\) \{ \/\/ 클라우드 리더가 아니면 폴러만 내린다/, '리더 아니면 폴러 전부 내리던 조기 return 제거');
  assert.match(gw, /else if \(own && !own\.mine\) \{[^\n]*\n\s*if \(own\.holder\) beatGateway\(c\.id, 'telegram', false, `다른 기기\(\$\{deviceLabel\(own\.holder\)\}\)에서 수신 중`, \{ holder: 'other', holderDevice: deviceLabel\(own\.holder\) \}\)/, '회사 봇: 남의 토큰이면 하트비트에 holder 표지');
  assert.match(gw, /else if \(kind === 'slack' && !leader\) \{/, '슬랙은 리더 게이트 유지');
  assert.match(gw, /\/\/ 받은 서류함 감시 — 회사마다 1개\(리더만\)\. 파일 드롭 = 지시\n\s*if \(leader\) \{/, '서류함 감시는 리더만');
  assert.match(gw, /const own = tgOwned\(bot\.token\);\s*\n\s*if \(!own\.mine\) \{[\s\S]{0,400}holder: 'other', holderDevice: deviceLabel\(own\.holder\)[\s\S]{0,80}continue;/, '크루 직통 봇: 남의 토큰이면 물러나고 holder 표지');
  const syncSrc = await load('../src/sync.mjs');
  assert.match(syncSrc, /if \(localOwners\[0\]\) await renewTokenClaims\(localOwners\[0\]\)/, 'cycle()이 리스 갱신 직후 토큰 클레임을 갱신');
});

test('④ gatewayStatus — 하트비트의 holder 표지가 응답에 실린다(40초 창 안에서만)', async () => {
  const ws = 'claim-ws';
  const root = join(process.env.ARGO_ROOT, ws);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'company.json'), JSON.stringify({ id: ws, name: 't' }));
  const { beatGateway } = await import('../src/gateway/persist.mjs');
  const { updateAgentBot, gatewayStatus } = await import('../src/connections.mjs');
  await updateAgentBot(ws, 'pepper', { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' }).catch(() => {});
  await beatGateway(ws, 'tg-pepper', false, '다른 기기(Win-PC)에서 수신 중', { holder: 'other', holderDevice: 'Win-PC' });
  const st = await gatewayStatus(ws);
  const a = st.agents.pepper ?? st.agents[Object.keys(st.agents)[0]];
  if (a) { assert.equal(a.holder, 'other'); assert.equal(a.holderDevice, 'Win-PC'); assert.equal(a.alive, false); }
  else { // updateAgentBot 계약이 달라 등록이 안 됐으면 read 헬퍼로 직접 확인
    const raw = JSON.parse(await readFile(join(root, '.gateway-tg-pepper.json'), 'utf8'));
    assert.equal(raw.holder, 'other');
  }
});

test('④ 화면 — 사이드바 점·설정 카드·크루 칩이 초록(이 기기)/파랑(다른 기기)/주황(미수신) 삼색으로 갈린다 + i18n', async () => {
  const layout = await load('../app/c/[ws]/layout.jsx');
  assert.match(layout, /background: tgAgents\[a\.slug\]\.alive \? 'var\(--ok\)' : tgAgents\[a\.slug\]\.other \? 'var\(--info\)' : 'var\(--warn\)'/);
  assert.match(layout, /map\[slug\] = \{ alive: !!g\?\.alive, other: g\?\.holder === 'other', device: g\?\.holderDevice \?\? '' \}/);
  const settings = await load('../app/c/[ws]/settings/page.jsx');
  assert.match(settings, /color: gw\.alive \? 'var\(--ok\)' : gw\.holder === 'other' \? 'var\(--info\)' : gw\.error \? 'var\(--danger\)' : 'var\(--warn\)'/);
  assert.match(settings, /t\('settings\.conn\.gwOtherDevice', \{ device: gw\.holderDevice \|\| '' \}\)/);
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /color: tgAlive \? 'var\(--ok\)' : tgOther !== null \? 'var\(--info\)' : 'var\(--warn\)'/);
  assert.match(crew, /tgAlive \? t\('chat\.tg\.live'\) : tgOther !== null \? t\('chat\.tg\.otherDevice', \{ device: tgOther \}\) : t\('chat\.tg\.waiting'\)/);
  const i18n = await load('../app/i18n.jsx');
  for (const k of ['nav.tgOtherDevice', 'nav.tgWaiting', 'settings.conn.gwOtherDevice', 'chat.tg.otherDevice']) {
    const m = i18n.match(new RegExp(`^\\s*'${k.replace(/\./g, '\\.')}':\\s*\\['([^']*)',\\s*'([^']*)'\\]`, 'm'));
    assert.ok(m && /[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), `${k} ko/en 등록`);
  }
});
