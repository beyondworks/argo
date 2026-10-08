// 개인 공간 결재(주인 + 자기 에이전트 1:1 방, msgr_crew_approvals.org_id NULL) — 메신저 앱 쪽 판정(계획 rc-0195 personal-crew-room-features-plan 5-4).
// 서버(PR-A 마이그레이션)의 msgr_can_decide 개인 갈래와 같은 규칙: org_id가 없는 결재는 위험 등급과 무관하게 크루 주인이 결정한다.
// '꼭 확인'(high) 표시는 그대로 둔다 — 등급은 서버 값이고, 바뀌는 것은 누가 버튼을 보느냐뿐이다.
//
// 앞 두 묶음(핀)은 배포본과 같아야 하는 조직 결재 판정이다 — 픽스처는 origin/main(d81cffd7)의 approval-display.js를 실행해 뽑은 값이다
// (생성 스크립트는 PR 본문). 새 함수는 이름공간으로 읽는다 — 옛 코드에서 이 파일이 통째로 실패하지 않고, 새 동작 테스트만 하나씩 빨개지게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../src/approval-display.js';

const fx = JSON.parse(readFileSync(new URL('./approval-decider-org.fixture.json', import.meta.url), 'utf8'));
const ME = fx.me;
const deskArgs = ({ input }) => ({ ap: input.ap, uid: input.uid, crewOwnerId: input.ownerUnknown ? undefined : input.crewOwnerId, isAdmin: input.isAdmin, policy: input.policy });

// ── 핀: 조직 결재는 배포본과 같다(경우 표 19의 앱 쪽) ──
test('핀 — 조직 결재 판정 행렬(데스크톱 슬립 108칸)이 배포본과 같다(personal을 주지 않을 때·false일 때 모두)', () => {
  assert.equal(fx.desk.length, 108);
  for (const row of fx.desk) {
    const args = deskArgs(row);
    assert.deepEqual(D.approvalDecider(args), row.out, JSON.stringify(row.input));
    assert.deepEqual(D.approvalDecider({ ...args, personal: false }), row.out, `personal:false ${JSON.stringify(row.input)}`);
  }
});

test('핀 — 폰 결재 판정 행렬(조직 결재 108칸 + 넣기 요청)·결정 가능 목록·안내 문구가 배포본과 같다. org_id가 빠진 행(undefined)은 개인으로 보지 않는다', () => {
  const ctx = { uid: ME, orgs: fx.orgs };
  assert.equal(fx.phone.length, 109);
  for (const row of fx.phone) {
    const d = D.phoneApprovalDecider(row.it, ctx);
    assert.deepEqual(d, row.out, JSON.stringify(row.it));
    assert.equal(D.approvalOnlyKey(d), row.onlyKey, JSON.stringify(row.it));
  }
  assert.deepEqual(D.decidableApprovals(fx.phone.map((r) => r.it), ctx).map((x) => x.key), fx.decidable);
});

// ── 새 동작: 개인 결재 ──
const OTHER = 'someone-else';
const personal = (o) => D.approvalDecider({ ap: { risk: o.risk }, uid: ME, crewOwnerId: o.owner, isAdmin: o.admin ?? false, policy: o.policy ?? null, personal: true });

test('개인 결재 — 크루 주인은 모든 등급에서 결정 버튼을 본다. 꼭 확인(high) 표시는 그대로', () => {
  for (const risk of ['low', 'high', undefined]) {
    const d = personal({ risk, owner: ME });
    assert.equal(d.can, true, `주인 · ${risk}`);
    assert.equal(d.byAdmin, false, `주인 · ${risk} — 조직 관리자 대기로 가지 않는다`);
    assert.equal(d.high, risk === 'high', `꼭 확인 표시 · ${risk}`);
  }
});

test('개인 결재 — 주인이 아니면 등급과 무관하게 버튼이 없고, 안내는 소유자 문구(조직 결재권자 문구가 아니다)', () => {
  for (const risk of ['low', 'high']) {
    const d = personal({ risk, owner: OTHER });
    assert.equal(d.can, false, risk);
    assert.equal(d.byAdmin, false, risk);
    assert.equal(D.approvalOnlyKey(d), 'ap.ownerOnly', risk);
  }
});

test('개인 결재 — 관리자 표지·조직 정책이 섞여 와도 무시한다(개인 공간에는 조직 정책이 없다)', () => {
  assert.equal(personal({ risk: 'high', owner: OTHER, admin: true }).can, false, '관리자라도 남의 개인 결재는 못 한다');
  assert.equal(personal({ risk: 'high', owner: OTHER, policy: { approval_high_by: 'approvers', approver_user_ids: [ME] } }).can, false, '지정 결재권자 목록에 있어도 못 한다');
  assert.equal(personal({ risk: 'high', owner: ME, policy: { approval_high_by: 'admin' } }).can, true, '주인은 조직 정책 값과 무관하게 한다');
});

test('개인 결재 — 크루를 모르면(목록에 없음) 기존 규칙처럼 소유자로 보고 버튼을 띄운다(최종은 서버 msgr_can_decide)', () => {
  assert.equal(personal({ risk: 'high', owner: undefined }).can, true);
  assert.equal(personal({ risk: 'low', owner: undefined }).can, true);
});

test('폰 결재 — org_id가 NULL인 행은 개인 결재: 주인은 꼭 확인도 결정, 남의 것은 빠진다. 조직 행은 그대로', () => {
  const ctx = { uid: ME, orgs: [{ id: 'o-member', role: 'member' }] };
  const row = (id, org, risk, owner) => ({ key: `approval:${id}`, kind: 'approval', id, org_id: org, risk, crewOwnerId: owner, policy: null, at: '2026-10-08T00:00:00Z' });
  const items = [
    row('p-high-mine', null, 'high', ME),
    row('p-low-mine', null, 'low', ME),
    row('p-high-other', null, 'high', OTHER),
    row('o-high-mine', 'o-member', 'high', ME), // 조직 멤버 + 기본 정책 — 지금처럼 못 함
    row('o-low-mine', 'o-member', 'low', ME),
  ];
  assert.equal(D.phoneApprovalDecider(items[0], ctx).can, true);
  assert.equal(D.phoneApprovalDecider(items[0], ctx).high, true, '꼭 확인 표시 유지');
  assert.equal(D.approvalOnlyKey(D.phoneApprovalDecider(items[2], ctx)), 'ap.ownerOnly');
  assert.deepEqual(D.decidableApprovals(items, ctx).map((x) => x.key), ['approval:p-high-mine', 'approval:p-low-mine', 'approval:o-low-mine']);
});

// ── 폰 결재 목록 조회: 요청 한 번(or 필터), 개인 high는 정책 조회를 늘리지 않는다 ──
function recorder() {
  const calls = [];
  const b = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return b; } });
  return { b, calls };
}

test('폰 결재 조회 범위 — 조직이 있으면 조직 결재 + 개인 결재를 한 번의 or 필터로, 조직이 없으면 개인 결재만. 필터 호출은 한 번', () => {
  assert.equal(typeof D.scopePendingApprovals, 'function');
  const a = recorder();
  assert.equal(D.scopePendingApprovals(a.b, ['o1', 'o2']), a.b, '같은 쿼리 빌더를 이어 돌려준다(요청 하나)');
  assert.deepEqual(a.calls, [['or', 'org_id.in.(o1,o2),org_id.is.null']]);
  const z = recorder();
  D.scopePendingApprovals(z.b, []);
  assert.deepEqual(z.calls, [['is', 'org_id', null]]);
  const e = recorder();
  D.scopePendingApprovals(e.b, ['', null, 'o1', 'x),org_id.not.is.null', 'a,b']);
  assert.deepEqual(e.calls, [['or', 'org_id.in.(o1),org_id.is.null']], '빈 id와 필터 문자열을 바꿀 수 있는 글자(괄호·쉼표·점)가 든 id는 거른다');
  const u = recorder();
  D.scopePendingApprovals(u.b, ['0b6c1a52-3f0e-4c1e-9a77-2d1f5e0c9b11']);
  assert.deepEqual(u.calls, [['or', 'org_id.in.(0b6c1a52-3f0e-4c1e-9a77-2d1f5e0c9b11),org_id.is.null']], '조직 id(uuid)는 그대로');
});

// PostgREST 필터 두 모양만 읽는 작은 평가기 — 모르는 모양이면 던진다(테스트가 조용히 통과하지 않게).
function rowsFor(calls, rows) {
  assert.equal(calls.length, 1);
  const [name, ...args] = calls[0];
  if (name === 'in' && args[0] === 'org_id') return rows.filter((r) => args[1].includes(r.org_id));
  if (name === 'is' && args[0] === 'org_id' && args[1] === null) return rows.filter((r) => r.org_id === null);
  if (name === 'or') {
    const m = /^org_id\.in\.\(([^)]*)\),org_id\.is\.null$/.exec(args[0]);
    if (!m) throw new Error(`모르는 or 필터: ${args[0]}`);
    const ids = m[1].split(',');
    return rows.filter((r) => r.org_id === null || ids.includes(r.org_id));
  }
  throw new Error(`모르는 필터: ${name}`);
}

test('지금 데이터(개인 결재 행 0 — 운영 org_id NOT NULL)에서는 새 조회 결과가 예전 .in(org_id) 결과와 같다', () => {
  const rows = [{ id: 1, org_id: 'o1' }, { id: 2, org_id: 'o2' }, { id: 3, org_id: 'o3' }, { id: 4, org_id: 'o1' }];
  const ids = ['o1', 'o2'];
  const oldQ = recorder(); oldQ.b.in('org_id', ids);
  const newQ = recorder(); D.scopePendingApprovals(newQ.b, ids);
  assert.deepEqual(rowsFor(newQ.calls, rows), rowsFor(oldQ.calls, rows));
  const withPersonal = [...rows, { id: 5, org_id: null }];
  assert.deepEqual(rowsFor(newQ.calls, withPersonal).map((r) => r.id), [1, 2, 4, 5], '개인 결재 행이 생기면 그것만 더해진다');
});

test('꼭 확인 정책을 읽을 조직 — 개인 결재(org_id NULL)는 빠진다(조직 정책 조회가 늘지 않고 .in(org_id,[null])을 만들지 않는다)', () => {
  assert.equal(typeof D.highPolicyOrgs, 'function');
  const aps = [{ risk: 'high', org_id: null }, { risk: 'high', org_id: 'o1' }, { risk: 'high', org_id: 'o1' }, { risk: 'low', org_id: 'o2' }, { risk: 'high', org_id: 'o3' }];
  assert.deepEqual(D.highPolicyOrgs(aps), ['o1', 'o3']);
  assert.deepEqual(D.highPolicyOrgs([{ risk: 'high', org_id: null }]), [], '개인 high만 있으면 정책 조회 0');
  assert.deepEqual(D.highPolicyOrgs(null), []);
});

test('채널 결재 카드의 결정 거절 안내 — 조직은 지금과 같고(high=결재권자, low=소유자), 개인은 등급과 무관하게 소유자 문구', () => {
  assert.equal(typeof D.approvalDeniedKey, 'function');
  assert.equal(D.approvalDeniedKey({ risk: 'high' }, false), 'ap.approverOnly');
  assert.equal(D.approvalDeniedKey({ risk: 'low' }, false), 'ap.ownerOnly');
  assert.equal(D.approvalDeniedKey({}, false), 'ap.ownerOnly');
  assert.equal(D.approvalDeniedKey({ risk: 'high' }, true), 'ap.ownerOnly');
  assert.equal(D.approvalDeniedKey({ risk: 'low' }, true), 'ap.ownerOnly');
});

// ── 연결(App.jsx는 JSX라 node가 직접 실행할 수 없다 — 소스 문자열로만 본다. 행동은 위 함수 테스트가 잠그고, 화면은 따로 띄워 본다) ──
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const between = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));

test('연결 — 폰 결재 목록은 조회 범위 함수로 한 번만 읽고(조직이 없어도 개인 결재를 읽는다), 정책은 조직 high만', () => {
  const load = between('const loadApprovals = useCallback(async () => {\n    if (!uid || !isPhoneRef.current) return;', '}, [uid, orgIdsKey]);');
  assert.match(load, /scopePendingApprovals\(supabase\.from\('msgr_crew_approvals'\)\.select\('id, org_id, channel_id, crew_id, action, reason, payload, risk, kind, created_at, msgr_crews\(owner_user_id\)'\), ids\)\.eq\('status', 'pending'\)/);
  assert.doesNotMatch(load, /\.in\('org_id', ids\)/, '조직만 읽던 필터가 남아 있다');
  assert.equal((load.match(/from\('msgr_crew_approvals'\)/g) ?? []).length, 1, '결재 표 조회는 한 번');
  assert.match(load, /const highOrgs = highPolicyOrgs\(aps\);/);
});

test('연결 — 채널의 결재 슬립은 개인 공간 표지를 받아 판정 함수에 넘기고, 결정 거절 안내도 같은 표지로', () => {
  assert.match(app, /: ap \? <Slip ap=\{ap\} uid=\{uid\} lang=\{lang\} t=\{t\} crew=\{crew\} nameOfUser=\{nameOfUser\} decide=\{decide\} isAdmin=\{isAdmin\} policy=\{policy\} personal=\{isPersonal\} \/>/);
  const slip = between('function Slip(', 'function Composer(');
  assert.match(slip, /^function Slip\(\{ ap, uid, lang, t, crew, nameOfUser, decide, isAdmin, policy, personal = false \}\)/);
  assert.match(slip, /approvalDecider\(\{ ap, uid, crewOwnerId: crew \? crew\.owner_user_id : undefined, isAdmin, policy, personal \}\)/);
  assert.match(app, /else if \(r\.result === 'denied'\) onError\(t\(approvalDeniedKey\(ap, isPersonal\)\)\);/);
});

test('핀 — 업무 패널은 개인 공간에서 계속 숨기고, 결재 OS 알림은 관리자에게만(바꾸지 않는다)', () => {
  assert.match(app, /\{!isPersonal && <button type="button" className="btn sm msgr-work-button"/);
  assert.match(app, /if \(!payload \|\| payload\.status !== 'pending' \|\| !r\.isAdmin \|\| !shouldNotify\(payload\.channel_id\)\) return;/);
});
