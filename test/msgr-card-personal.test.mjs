// CX-12·CX-13(2026-10-05 연결성 검수): 설정 메신저 카드가 개인 공간 이전 기준이라 조직이 없으면 '연결 필요'·'조직을 만드세요'만
// 보이고 실행기 연결 상태를 숨겼다. 본체 어디에도 오피스로 가는 길이 없었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msgrConnectionChip, msgrShowRuntime, MESSENGER_PAGE } from '../app/c/[ws]/settings/msgr-card.mjs';

test('조직이 없어도 개인 공간에 연결된 크루가 있으면 "개인 공간 연결됨" — 연결 필요로 보이지 않는다', () => {
  assert.equal(msgrConnectionChip({ regCount: 0, personalCount: 3 }), 'personal');
  assert.equal(msgrConnectionChip({ regCount: 2, personalCount: 3 }), 'connected');
  assert.equal(msgrConnectionChip({ regCount: 0, personalCount: 0 }), 'notConnected');
});

test('실행기 연결 상태는 조직 여부와 상관없이 보인다(로그인 + 크루 있음)', () => {
  assert.equal(msgrShowRuntime({ signedIn: true, agentCount: 2 }), true);
  assert.equal(msgrShowRuntime({ signedIn: true, agentCount: 0 }), false);
  assert.equal(msgrShowRuntime({ signedIn: false, agentCount: 2 }), false);
});

test('진입 링크는 https 고정 주소 — 메신저 받기 안내 한 곳', () => {
  assert.equal(new URL(MESSENGER_PAGE).protocol, 'https:');
});

// 오피스는 아직 비공개 — 본체 앱 화면에서 오피스로 바로 가는 링크·버튼을 두지 않는다(유건 2026-10-10).
// 에이전트 도구가 서버 쪽에서 부르는 주소(src/gateway/office-files.mjs)는 화면 링크가 아니라 대상 밖.
test('본체 화면(app/)과 에이전트 도움말(src/help)에 오피스로 가는 링크·버튼 안내가 없다', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const hits = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'api') await walk(p); }
      else if (/\.(jsx?|mjs)$/.test(e.name)) {
        const s = await readFile(p, 'utf8');
        if (/argo-office\.vercel\.app|argo\.ceo\/office|OFFICE_URL|settings\.office\.|오피스 열기|Open Argo Office/.test(s)) hits.push(p);
      }
    }
  };
  await walk(new URL('../app/', import.meta.url).pathname);
  await walk(new URL('../src/help/', import.meta.url).pathname);
  assert.deepEqual(hits, []);
});

// UL10·UL7(2026-10-05 분리 검수): 위 테스트는 순수 함수 입력만 만들어 넣었다 — 서버가 실제로 내리는 응답(personalCount 필드)을 카드가 읽는 연결은 안 잠겼다.
// 라우트가 행을 나누는 함수(splitCardRows)의 출력을 그대로 카드 판정(msgrCardView)에 넣어 이름·모양이 어긋나면 빨강이 되게 한다.
// UL7: 개인 공간만 쓰는 사용자는 8초 실행기 폴이 안 돌았는데 문구는 "잠시 뒤 자동으로 다시 확인합니다"였다 — 폴 조건과 문구가 같은 판정(polling)을 쓴다.
import { splitCardRows } from '../app/api/companies/[ws]/msgr/card-rows.mjs';
import { msgrCardView, runtimeWaitingKey } from '../app/c/[ws]/settings/msgr-card.mjs';

const row = (extra) => ({ id: 'r', org_id: 'o1', slug: 'a', status: 'active', ...extra });

test('라우트가 행을 나눈다 — 조직 행은 crews, 개인 공간 행(org NULL)은 활성인 것만 personalCount', () => {
  const r = splitCardRows([row({ id: '1' }), row({ id: '2', org_id: null, slug: 'b' }), row({ id: '3', org_id: null, slug: 'c', status: 'detached' }), row({ id: '4', org_id: null, slug: 'd' })]);
  assert.deepEqual(r.crews.map((x) => x.id), ['1'], '개인 행은 연결·해제 판정 대상(crews)에서 뺀다');
  assert.equal(r.personalCount, 2, '활성 개인 행만 센다(detached 제외)');
  assert.deepEqual(splitCardRows(null), { crews: [], personalCount: 0 });
});

test('서버 응답 → 카드 판정 — 개인 공간만 있는 사용자: 칩 personal·실행기 영역 보임·자동 확인(폴) 없음', () => {
  const response = { signedIn: true, orgs: [], ...splitCardRows([row({ org_id: null, slug: 'a' }), row({ id: '2', org_id: null, slug: 'b' })]), runtime: { state: 'waiting' } };
  const view = msgrCardView({ st: response, orgId: '', agents: [{ slug: 'a' }, { slug: 'b' }] });
  assert.equal(view.chip, 'personal');
  assert.equal(view.personalCount, 2); assert.equal(view.regCount, 0);
  assert.equal(view.showRuntime, true);
  assert.equal(view.polling, false, '조직 크루가 없으니 8초 폴이 안 돈다 — 문구가 자동 확인을 약속하면 안 된다(UL7)');
  assert.equal(runtimeWaitingKey(view.polling), 'settings.msgr.runtime.waitingManual');
});

test('서버 응답 → 카드 판정 — 조직에 등록한 크루가 있으면 연결됨·폴이 돌고 자동 확인 문구', () => {
  const response = { signedIn: true, orgs: [{ id: 'o1', name: '조직', role: 'owner' }], ...splitCardRows([row({ slug: 'a' }), row({ id: '2', slug: 'b', status: 'available' })]), runtime: { state: 'alive', lastTs: 1 } };
  const view = msgrCardView({ st: response, orgId: 'o1', agents: [{ slug: 'a' }, { slug: 'b' }] });
  assert.equal(view.chip, 'connected'); assert.equal(view.regCount, 1, '활성 등록만 센다');
  assert.equal(view.polling, true);
  assert.equal(runtimeWaitingKey(view.polling), 'settings.msgr.runtime.waiting');
});

test('로그인 전·로드 전은 폴도 영역도 없다', () => {
  for (const st of [null, { signedIn: false, orgs: [], crews: [] }]) {
    const view = msgrCardView({ st, orgId: '', agents: [{ slug: 'a' }] });
    assert.equal(view.polling, false); assert.equal(view.showRuntime, false); assert.equal(view.chip, 'notConnected');
  }
});

// 2차 분리 검수 L6(2026-10-05): 개인 공간 offline에서 '다시 확인'과 '다시 연결'이 나란히 있고, login 상태는 문구가 "로그인한 뒤 다시 연결하세요"인데 단추는 '다시 확인'뿐이었다.
// → 상태별 단추 하나: offline·company = 다시 연결, login = 로그인, 그 밖 = (폴이 안 돌 때만) 다시 확인, alive = 없음.
import { runtimeAction } from '../app/c/[ws]/settings/msgr-card.mjs';

test('L6: 상태별 단추 하나 — 문구가 시키는 행동과 단추가 같다', () => {
  assert.equal(runtimeAction('login', { polling: false }), 'login', '"로그인한 뒤 다시 연결하세요" → 로그인');
  assert.equal(runtimeAction('login', { polling: true }), 'login');
  assert.equal(runtimeAction('offline', { polling: false }), 'reconnect', '개인 공간 offline — 다시 연결 하나(다시 확인 없음)');
  assert.equal(runtimeAction('offline', { polling: true }), 'reconnect');
  assert.equal(runtimeAction('company', { polling: false }), 'reconnect', '"다시 연결을 시도하세요"');
  assert.equal(runtimeAction('alive', { polling: false }), null);
  for (const state of ['waiting', 'reconnecting', 'owner', 'noCrews', undefined]) {
    assert.equal(runtimeAction(state, { polling: false }), 'recheck', `${state}: 폴이 없으면 다시 확인`);
    assert.equal(runtimeAction(state, { polling: true }), null, `${state}: 폴이 돌면 단추 없음(자동 확인)`);
  }
});
