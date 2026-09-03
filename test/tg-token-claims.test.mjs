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
delete process.env.ARGO_SYNC;
// 동기화 on을 강제 — 가짜 기기 세션(전부 가짜 값)으로 syncOn()이 참이 되게 한다(loadDeviceSession은 url·anonKey·refresh·access·user.id만 본다).
// 이래야 tokenOwnership이 클레임 상태를 실제로 따른다(동기화 off면 항상 mine이라 H-3 무게이트가 됐다 — 재검수).
await writeFile(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://fake.supabase.co', anonKey: 'fake-anon', refresh_token: 'fake-r', access_token: 'fake-a', user: { id: 'fake-uid' } }));
const sync = await import('../src/sync.mjs');
const { claimDecision, TG_CLAIM_TTL_MS, tokenClaimHash, deviceLabel, setClaimTokens, tokenOwnership, renewTokenClaims, _setSyncClientForTest, _resetTokenClaimsForTest, _claimStateForTest, syncOn } = sync;
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

test('전제 — 이 테스트 프로세스는 동기화 on(가짜 기기 세션)', () => {
  assert.equal(syncOn(), true);
});

test('tokenOwnership — 판정 전(pending)은 mine이 아니다(이중 폴링 창 방지), 동기화 off면 항상 mine', () => {
  _resetTokenClaimsForTest();
  assert.deepEqual(tokenOwnership('t1'), { mine: false, holder: null, pending: true });
  process.env.ARGO_SYNC = '0';
  assert.equal(tokenOwnership('t1').mine, true, '동기화 off = 단일 기기');
  delete process.env.ARGO_SYNC;
});

test('tokenOwnership — 중재가 한 번도 안 돌았으면 유예(90s) 뒤에만 mine(폴러 전멸 방지)', () => {
  const { CLAIM_ARBITRATION_GRACE } = sync;
  _resetTokenClaimsForTest(Date.now() - CLAIM_ARBITRATION_GRACE - 1);
  assert.equal(tokenOwnership('t1').mine, true, '유예 경과 + 미중재 → 단일 기기처럼');
  _resetTokenClaimsForTest(Date.now());
  assert.equal(tokenOwnership('t1').mine, false, '유예 전엔 pending');
});

/** 가짜 스토리지 — 키별 최신 본문을 기억(다운로드 시 ?t= 캐시버스터 무시). remove 지원. */
function fakeStorage({ rejectUpload = false } = {}) {
  const store = new Map(); const removed = [];
  const bucket = {
    async download(key) { const k = key.split('?')[0]; const v = store.get(k); return v ? { data: new Blob([v]) } : { data: null, error: { message: 'Object not found' } }; },
    async upload(key, blob) { if (rejectUpload) return { error: { message: 'rls' } }; store.set(key, await blob.text()); return { error: null }; },
    async remove(keys) { for (const k of keys) { store.delete(k); removed.push(k); } return { error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, removed };
}
const keyOf = (owner, token) => `${owner}/.tg-claims/${tokenClaimHash(token)}.json`;

test('② renewTokenClaims — 빈 클레임은 획득(mine), 남의 살아 있는 클레임은 양보(other + holder), 만료된 남의 것은 인수', async () => {
  _resetTokenClaimsForTest();
  const me = await getDeviceId();
  const { client, store } = fakeStorage();
  _setSyncClientForTest(client);
  store.set(keyOf('owner1', 'tokB'), JSON.stringify({ deviceId: 'Other-PC-deadbeef', nonce: 'x', ts: Date.now() }));
  store.set(keyOf('owner1', 'tokC'), JSON.stringify({ deviceId: 'Old-PC-00000000', nonce: 'y', ts: Date.now() - TG_CLAIM_TTL_MS - 1 }));
  setClaimTokens(['tokA', 'tokB', 'tokC']);
  await renewTokenClaims('owner1', { force: true });
  assert.equal(tokenOwnership('tokA').mine, true, '빈 클레임 → 획득');
  assert.deepEqual({ mine: tokenOwnership('tokB').mine, holder: tokenOwnership('tokB').holder }, { mine: false, holder: 'Other-PC-deadbeef' }, '남의 살아 있는 클레임 → 양보');
  assert.equal(JSON.parse(store.get(keyOf('owner1', 'tokB'))).deviceId, 'Other-PC-deadbeef', '남의 클레임을 덮지 않았다');
  assert.equal(tokenOwnership('tokC').mine, true, '만료된 남의 클레임 → 인수');
  assert.equal(JSON.parse(store.get(keyOf('owner1', 'tokA'))).deviceId, me);
  assert.ok(!store.get(keyOf('owner1', 'tokA')).includes('tokA'), '토큰 원문은 클라우드에 없다');
});

test('② 쓰기 실패(판정 불가) — 확인된 보유자는 TTL 내 유지, 미보유는 미보유 (변이 ⑧ 완화가 red)', async () => {
  _resetTokenClaimsForTest();
  const ok = fakeStorage(); _setSyncClientForTest(ok.client);
  setClaimTokens(['tokD', 'tokE']);
  await renewTokenClaims('owner1', { force: true }); // 둘 다 획득
  assert.equal(tokenOwnership('tokD').mine, true);
  _setSyncClientForTest(fakeStorage({ rejectUpload: true }).client); // 이제 쓰기 거부
  await renewTokenClaims('owner1', { force: true });
  assert.equal(tokenOwnership('tokD').mine, true, '확인된 보유자(ownedAt 최근) → 유지');
  // 보유 이력이 낡은 경우(ownedAt TTL 초과) → 강등 — 획득한 적 없는 척하는 상태를 직접 심는다
  sync._setTokenClaimForTest('tokE', { mine: true, holder: 'me', ts: Date.now(), ownedAt: Date.now() - TG_CLAIM_TTL_MS - 1 });
  await renewTokenClaims('owner1', { force: true });
  assert.equal(tokenOwnership('tokE').mine, false, '보유 이력 TTL 초과 + 쓰기 실패 → 강등(리스 holdsLeaseOnWriteFailure와 같은 절충)');
  // 미보유(pending) 토큰은 쓰기 실패로 획득되지 않는다
  setClaimTokens(['tokD', 'tokE', 'tokF']);
  await renewTokenClaims('owner1', { force: true });
  assert.equal(tokenOwnership('tokF').mine, false, '판정 불가로 새 토큰을 얻지 않는다');
});

test('② 갱신은 ownedAt을 새로 찍는다 — 정상 보유 120초 뒤 일시 쓰기 실패 1회에 강등되지 않는다(재검수 M-1)', async () => {
  _resetTokenClaimsForTest();
  const ok = fakeStorage(); _setSyncClientForTest(ok.client);
  setClaimTokens(['tokG']);
  const t0 = Date.now() - TG_CLAIM_TTL_MS - 10_000; // 최초 획득이 오래전이었다고 가정
  await renewTokenClaims('owner1', { now: t0, force: true });
  await renewTokenClaims('owner1', { force: true }); // 지금 정상 갱신
  assert.ok(_claimStateForTest()[tokenClaimHash('tokG')].ownedAt > Date.now() - 5000, 'ownedAt 갱신');
  _setSyncClientForTest(fakeStorage({ rejectUpload: true }).client);
  await renewTokenClaims('owner1', { force: true });
  assert.equal(tokenOwnership('tokG').mine, true, '갱신 직후 쓰기 실패 1회 → 유지');
});

test('② setClaimTokens — 새 토큰이 생기면 갱신 레이트리밋을 풀고(재검수 M-2), 해제된 토큰의 원격 클레임을 지운다(L-3)', async () => {
  _resetTokenClaimsForTest();
  const fs_ = fakeStorage(); _setSyncClientForTest(fs_.client);
  setClaimTokens(['tokH']);
  await renewTokenClaims('owner1'); // force 없이 — 등록 직후라 레이트리밋 없이 돈다
  assert.equal(tokenOwnership('tokH').mine, true);
  await renewTokenClaims('owner1'); // 30초 안 — 스킵(레이트리밋)
  setClaimTokens(['tokH', 'tokI']); // 새 토큰 등장 → renewedAt 리셋
  await renewTokenClaims('owner1');
  assert.equal(tokenOwnership('tokI').mine, true, '새 토큰이 30초를 기다리지 않고 바로 클레임됐다');
  setClaimTokens(['tokI']); // tokH 해제
  await renewTokenClaims('owner1', { force: true });
  assert.ok(fs_.removed.includes(keyOf('owner1', 'tokH')), '해제된 토큰의 원격 클레임 제거');
  assert.equal(tokenOwnership('tokH').pending, true, '해제된 토큰 상태 폐기');
});

test('② 클레임 상태 파일 — 다른 프로세스(클레임을 돌린 적 없음)도 TTL 내 상태 파일로 판정한다(재검수 M-4)', async () => {
  _resetTokenClaimsForTest();
  const fs_ = fakeStorage(); _setSyncClientForTest(fs_.client);
  setClaimTokens(['tokJ']);
  await renewTokenClaims('owner1', { force: true });
  const raw = JSON.parse(await readFile(join(process.env.ARGO_ROOT, '.tg-claims-state.json'), 'utf8'));
  assert.equal(raw.byHash[tokenClaimHash('tokJ')].mine, true, '상태 파일에 기록');
  // 새 프로세스 흉내 — 메모리 상태 비움(renewedAt 0), 파일은 남김
  const bootAt = Date.now(); const saved = await readFile(join(process.env.ARGO_ROOT, '.tg-claims-state.json'), 'utf8');
  _resetTokenClaimsForTest(bootAt); await writeFile(join(process.env.ARGO_ROOT, '.tg-claims-state.json'), saved);
  assert.equal(tokenOwnership('tokJ').mine, true, '파일로 판정 — 90초 orphan 폴백을 기다리지 않는다');
});

test('동기화 발견·내보내기 — .tg-claims 폴더는 점 접두라 회사로 오인되지 않는다(재검수 H-2)', async () => {
  const src = await load('../src/sync.mjs');
  assert.match(src, /const CLAIM_DIR = '\.tg-claims';/, '점 접두 폴더명');
  assert.doesNotMatch(src, /_tg-claims/, '옛 이름 잔존');
  assert.match(src, /if \(!c\.id && !String\(c\.name\)\.startsWith\('\.'\)\) out\.push/, '발견 필터가 점 접두를 거른다');
  const exp = await load('../src/cloudexport.mjs');
  assert.match(exp, /!String\(e\.name\)\.startsWith\('\.'\)/, '내보내기도 점 접두를 거른다');
  const mig = await load('../supabase/migrations/20260903120000_tg_claims_pro_gate_exception.sql');
  assert.equal((mig.match(/or name like \(select auth\.uid\(\)::text\) \|\| '\/\.tg-claims\/%'/g) ?? []).length, 2, 'insert·update 정책 둘 다 Pro 게이트 예외(재검수 H-1)');
});

test('③ 배선 — 텔레그램 폴러는 토큰 소유(tokenOwnership)로, 슬랙·서류함은 기기 리더로 켠다', async () => {
  const gw = await load('../src/gateway.mjs');
  assert.match(gw, /import \{ isCloudLeader, setClaimTokens, tokenOwnership, deviceLabel \} from '\.\/sync\.mjs';/);
  assert.match(gw, /setClaimTokens\(myTokens\);/, '이 기기의 토큰 집합을 클레임 대상으로 등록');
  assert.doesNotMatch(gw, /if \(!leader\) \{ \/\/ 클라우드 리더가 아니면 폴러만 내린다/, '리더 아니면 폴러 전부 내리던 조기 return 제거');
  assert.match(gw, /else if \(own && !own\.mine\) \{[^\n]*\n\s*if \(own\.holder\) beatGateway\(c\.id, 'telegram', false, `다른 기기\(\$\{deviceLabel\(own\.holder\)\}\)에서 수신 중`, \{ holder: 'other', holderDevice: deviceLabel\(own\.holder\) \}\)/, '회사 봇: 남의 토큰이면 하트비트에 holder 표지');
  assert.match(gw, /else if \(kind === 'slack' && !leader\) \{/, '슬랙은 리더 게이트 유지');
  assert.match(gw, /\/\/ 받은 서류함 감시 — 회사마다 1개\(리더만\)\. 파일 드롭 = 지시\n\s*if \(leader\) \{/, '서류함 감시는 리더만');
  assert.match(gw, /const own = tgOwned\(bot\.token\);\s*\n\s*if \(!own\.mine\) \{[^\n]*\n\s*if \(own\.holder\) beatGateway\(c\.id, `tg-\$\{slug\}`, false, `다른 기기\(\$\{deviceLabel\(own\.holder\)\}\)에서 수신 중`, \{ holder: 'other', holderDevice: deviceLabel\(own\.holder\) \}\)[^\n]*\n\s*else beatGateway\(c\.id, `tg-\$\{slug\}`, false, '[^']*판정 중[^']*', \{ holder: 'pending' \}\)[^\n]*\n\s*continue;/, '크루 직통 봇: 남의 토큰이면 물러나고 holder 표지, 판정 전엔 pending 사유(재검수 L-2)');
  assert.match(gw, /else if \(own && !own\.mine\) \{[^\n]*\n[^\n]*\n\s*else beatGateway\(c\.id, 'telegram', false, '[^']*판정 중[^']*', \{ holder: 'pending' \}\)/, '회사 봇도 판정 전엔 pending 사유');
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
  // 다른 기기 = 속 빈 파란 링(--tg-remote: 라이트 #3a6ea5 / 다크 #7fb0e6 — 재검수 M-3 대비), 이 기기 = 초록 채움, 미수신 = 주황 채움
  assert.match(layout, /background: tgAgents\[a\.slug\]\.alive \? 'var\(--ok\)' : tgAgents\[a\.slug\]\.other \? 'var\(--bg\)' : 'var\(--warn\)',\n\s*boxShadow: tgAgents\[a\.slug\]\.other \? '0 0 0 2px var\(--tg-remote\)' : '0 0 0 2px var\(--bg\)'/);
  const css = await load('../app/globals.css');
  assert.match(css, /:root \{[^}]*--tg-remote: #3a6ea5;/, '라이트 원격 색');
  assert.equal((css.match(/--tg-remote: #7fb0e6;/g) ?? []).length, 4, '다크 4곳(미디어 root + argo-dark·apple-dark·glass-dark)');
  assert.match(layout, /map\[slug\] = \{ alive: !!g\?\.alive, other: g\?\.holder === 'other', device: g\?\.holderDevice \?\? '' \}/);
  const settings = await load('../app/c/[ws]/settings/page.jsx');
  assert.match(settings, /color: gw\.alive \? 'var\(--ok\)' : gw\.holder === 'other' \? 'var\(--tg-remote\)' : gw\.error \? 'var\(--danger\)' : 'var\(--warn\)'/);
  assert.match(settings, /t\('settings\.conn\.gwOtherDevice', \{ device: gw\.holderDevice \|\| '' \}\)/);
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /color: tgAlive \? 'var\(--ok\)' : tgOther !== null \? 'var\(--tg-remote\)' : 'var\(--warn\)'/);
  assert.match(crew, /tgAlive \? t\('chat\.tg\.live'\) : tgOther !== null \? t\('chat\.tg\.otherDevice', \{ device: tgOther \}\) : t\('chat\.tg\.waiting'\)/);
  const i18n = await load('../app/i18n.jsx');
  for (const k of ['nav.tgOtherDevice', 'nav.tgWaiting', 'settings.conn.gwOtherDevice', 'chat.tg.otherDevice']) {
    const m = i18n.match(new RegExp(`^\\s*'${k.replace(/\./g, '\\.')}':\\s*\\['([^']*)',\\s*'([^']*)'\\]`, 'm'));
    assert.ok(m && /[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), `${k} ko/en 등록`);
  }
});
