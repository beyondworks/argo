// 10/5 연결성 CX-07(내 이름이 메신저와 같은 원천) · CX-10(메신저에서 이미 정한 결재를 오피스에서 누를 때의 안내).
// session.js·transport.js는 Vite 환경값을 읽는 모듈을 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜를 넣어 그대로 실행한다(session-switch·storage-scope 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { isSameUserEcho, switchNeedsReload } from '../src/core/auth-events.js';
import * as B from '../src/core/board.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const run = (file, deps, rewrite = (s) => s) => {
  const source = rewrite(readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, ''));
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
};

/** 로그인 한 번 — orgRows: msgr_org_members 응답, profile: msgr_profiles 응답({ data, error }) */
async function signIn({ orgRows, profile, meta = { full_name: '김유건' } }) {
  const user = { id: 'u1', email: 'beyondworks.br@example.com', user_metadata: meta };
  const chain = (table) => ({ select: () => ({ eq: () => (table === 'msgr_profiles' ? { maybeSingle: async () => profile } : { is: async () => ({ data: orgRows, error: null }) }) }) });
  const sb = { auth: { getSession: async () => ({ data: { session: { user } } }), onAuthStateChange() {} }, from: chain };
  const s = run('session.js', { useSyncExternalStore() {}, SAMPLE: { SPACES: [{ key: 'me' }], ME: { id: 'sample' } }, configured: true, getClient: async () => sb, devPasswordLogin: false,
    isDesktop: () => false, restore: () => null, persist() {}, setStorageScope() {}, isSameUserEcho, switchNeedsReload, location: { reload() {} },
    __imp: async (p) => (p === './store.js' ? { activateDraftScope() {} } : { activateSyncScope: async () => {} }) }, (src) => src.replace(/import\('(\.\/(?:store|sync)\.js)'\)/g, "__imp('$1')"));
  await s.initSession(); await tick();
  return s;
}
const org = { role: 'member', display_name: '김효율', org: { id: 'o1', name: 'Beyondworks', slug: 'bw', deleted_at: null } };

// 이유(CX-07, 운영 SELECT): 같은 계정이 오피스는 로그인 정보 '김유건', 메신저 프로필 'leankim', 조직 표시 이름 '김효율'로 달랐다 — 결재하면 '김유건이 승인'이 보이다가
// 새로 읽으면 '김효율'로 바뀌었다. 메신저·서버(msgr_person_label)와 같은 규칙: 조직은 그 조직의 내 표시 이름, 내 공간은 프로필 이름 → 이메일 앞부분
test('CX-07: 내 이름 — 조직은 조직 표시 이름, 내 공간은 프로필 이름(없으면 이메일 앞부분), 프로필을 못 읽으면 로그인 정보', async () => {
  const s = await signIn({ orgRows: [org], profile: { data: { display_name: 'leankim' }, error: null } });
  assert.equal(s.ME.name, 'leankim');
  assert.deepEqual([s.nameIn?.('bw'), s.nameIn?.('me')], ['김효율', 'leankim']);
  const noName = await signIn({ orgRows: [{ ...org, display_name: null }], profile: { data: { display_name: '  ' }, error: null } });
  assert.deepEqual([noName.ME.name, noName.nameIn?.('bw')], ['beyondworks.br', 'beyondworks.br'], '프로필 이름이 비면 이메일 앞부분(서버 msgr_person_label과 같다)');
  const failed = await signIn({ orgRows: [org], profile: { data: null, error: { message: 'down' } } });
  assert.equal(failed.ME.name, '김유건', '프로필을 못 읽으면 종전처럼 로그인 정보의 이름');
});

// 이유(CX-10): 메신저에서 이미 정한 결재를 오피스에서 누르면 '승인했습니다' 뒤 '이 결재를 결정할 권한이 없습니다'가 떠서 권한 문제로 착각했다.
// 결정 전(결재함)과 0행 거절 뒤(전송함)가 같은 판정으로 '이미 다른 곳에서 승인된 결재'를 알린다
test('CX-10: 결재 지금 상태 → 안내(대기 = 그대로 결정, 정해짐 = 이미 처리됨, 없음 = 찾을 수 없음)', () => {
  assert.equal(B.apStale?.('pending'), null);
  assert.deepEqual(B.apStale?.('approved'), { key: 'ap.already', result: 'approved' });
  assert.deepEqual(B.apStale?.('rejected'), { key: 'ap.already', result: 'rejected' });
  assert.deepEqual(B.apStale?.(undefined), { key: 'ap.gone' });
});

test('CX-10: 전송함 0행 거절 — 그 사이 다른 곳에서 정했으면 권한 없음이 아니라 이미 처리됨', async () => {
  const toasts = [];
  const transport = (status, error = null) => {
    let reject;
    run('transport.js', { setTransport: (_, r) => { reject = r; }, getState: () => ({}), update() {}, getMode: () => 'signedIn', SPACES: [], ME: { id: 'alice' }, getStorageScope: () => 'alice',
      getClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: status === undefined ? null : { status }, error }) }) }) }) }),
      classify: (e) => e, setUi() {}, getUi: () => ({}), showToast: (m) => toasts.push(m), t: (k, v) => (v?.result ? `${k}:${v.result}` : k), persist() {}, heldKey: (id) => id,
      scopedStorageKey: (k) => k, apiUrl: (u) => u, announce() {}, apStale: B.apStale, openExternal() {}, FAMILY: {} });
    return reject;
  };
  for (const [status, error, want] of [['approved', null, 'ap.already:status.approved'], ['pending', null, 'ap.noRight'], [undefined, { message: 'x' }, 'ap.noRight']]) {
    toasts.length = 0;
    transport(status, error)({ payload: { type: 'approval.decide', id: 'a1', ownerUid: 'alice' } }, { decide: true });
    await tick(); await tick();
    assert.deepEqual(toasts, [want], String(status));
  }
});
