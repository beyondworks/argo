// 회사 단위 메신저 알림 목적지(설정 › Argo 메신저 연결 › 알림 받을 방) + Castra 실행 계약의 시스템 프롬프트 포함.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-notify-')); // 격리 루트 — 실데이터·저장소 workspaces/ 미접촉(gateway.test.mjs 관례)
import { normalizeMsgrNotify, msgrNotifyWants, formatMsgrNotify, msgrNotifyCrewSlug, MSGR_NOTIFY_EVENTS } from '../src/msgr-notify.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', CH = '22222222-2222-4222-8222-222222222222';

test('normalizeMsgrNotify — 끔은 null, 잘못된 id는 던짐, 이벤트는 목록 밖·중복 제거 후 정렬', () => {
  assert.equal(normalizeMsgrNotify(null), null); assert.equal(normalizeMsgrNotify(undefined), null); assert.equal(normalizeMsgrNotify('x'), null);
  assert.throws(() => normalizeMsgrNotify({ orgId: 'bad', channelId: CH }), /msgr_notify_bad_target/);
  assert.deepEqual(normalizeMsgrNotify({ orgId: ORG, channelId: CH, events: ['job', 'approval', 'job', 'nope'] }), { orgId: ORG, channelId: CH, events: ['approval', 'job'] });
  assert.deepEqual(normalizeMsgrNotify({ orgId: ORG, channelId: CH }).events, []);
  assert.ok(MSGR_NOTIFY_EVENTS.includes('approval') && MSGR_NOTIFY_EVENTS.includes('job'));
});

test('msgrNotifyWants — 켜진 종류만, 루틴은 자기 목적지가 없을 때만', () => {
  const n = { orgId: ORG, channelId: CH, events: ['job', 'routine'] };
  assert.equal(msgrNotifyWants(n, { type: 'job' }), true);
  assert.equal(msgrNotifyWants(n, { type: 'approval' }), false);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r' } }), true);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r', notifications: { channels: [] } } }), false, '루틴 자기 목적지(#513)가 우선');
  assert.equal(msgrNotifyWants(null, { type: 'job' }), false);
});

test('formatMsgrNotify — 종류별 머리·이름 치환(slug 노출 없음)·ko/en', () => {
  const names = { alpha: '알파', beta: '베타' };
  assert.match(formatMsgrNotify({ type: 'crewmail', from: 'alpha', slug: 'beta', reply: '보고' }, 'ko', names), /^\[동료 쪽지\] 알파 → 베타\n\n보고$/);
  assert.match(formatMsgrNotify({ type: 'job', title: '긴 작업', ok: true, reply: '끝' }, 'ko'), /^\[장시간 작업 완료\] 긴 작업/);
  assert.match(formatMsgrNotify({ type: 'job', title: 'T', ok: false, reply: 'x' }, 'en'), /^\[Long task stopped\] T/);
  assert.match(formatMsgrNotify({ type: 'approval', item: { action: '메일 발송', reason: '고객 회신' } }, 'ko'), /^\[결재 요청\] 메일 발송\n고객 회신\n\(아르고 앱/);
  assert.match(formatMsgrNotify({ type: 'delegate', from: 'alpha', to: 'beta', task: '정리', reply: '완료' }, 'en', names), /^\[Delegation result\] 알파 → 베타: 정리/);
  assert.equal(formatMsgrNotify({ type: 'nope' }), '');
  assert.equal(msgrNotifyCrewSlug({ type: 'approval', item: { slug: 'a' } }), 'a');
  assert.equal(msgrNotifyCrewSlug({ type: 'routine', routine: { agentSlug: 'r' } }), 'r');
  assert.equal(msgrNotifyCrewSlug({ type: 'delegate', to: 'b' }), 'b');
  assert.equal(msgrNotifyCrewSlug({ type: 'job', slug: 'j' }), 'j');
});

test('pushEvent — 원점 없는 이벤트만 회사 목적지로 간다(원점 있음·종류 미선택·미설정은 호출 0)', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-room';
  await createCompany(ws, '알림 방 검수', 'beta');
  const calls = [];
  const notifyMsgr = async (event, target) => { calls.push({ type: event.type, ch: target.channelId }); return true; };
  const pushMsgr = async () => false;
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [], '미설정이면 가지 않는다');
  const company = await loadCompany(ws);
  await updateCompany(ws, { msgr: { ...(company.msgr ?? {}), notify: { orgId: ORG, channelId: CH, events: ['job', 'crewmail'] } } });
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r', msgr: { channelId: 'origin' } }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '쪽지' }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '쪽지', msgr: { channelId: 'origin' } }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'approval', wsId: ws, item: { id: 'a1', slug: 'beta', action: 'x' } }, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [{ type: 'job', ch: CH }, { type: 'crewmail', ch: CH }], '원점 있는 job·crewmail과 미선택 approval은 제외');
  await updateCompany(ws, { msgr: { ...(await loadCompany(ws)).msgr, notify: { orgId: ORG, channelId: CH, events: ['job'] } } });
  const boom = async () => { throw new Error('room offline'); };
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr: boom });
});

test('시스템 프롬프트 — Castra 실행 계약이 ko/en 골격 모두에 안전 한계 앞에 들어가고, Castra 스크립트 이름은 없다(크루에게 없는 도구)', async () => {
  const { systemPromptFor, castraPosture } = await import('../src/chat.mjs');
  for (const lang of ['ko', 'en']) {
    const p = systemPromptFor('# 카드', '/tmp/ws', '', { name: '알파' }, lang);
    const at = p.indexOf('## Castra execution contract'); const safety = p.indexOf(lang === 'en' ? '## Safety limits' : '## 안전 한계');
    assert.ok(at > 0 && safety > at, `${lang}: Castra 절이 안전 한계 앞에`);
    assert.doesNotMatch(p, /castra_runtime\.py|castra_notes\.py|Stop guard|circuit breaker/, 'Argo 크루에 없는 Castra 도구·훅을 지시하지 않는다');
    for (const h of ['### Start from the user\'s result', '### Make checks capable of catching the defect', '### Stop on an evidenced outcome', '### Precedence']) assert.ok(p.includes(h), `${lang}: ${h}`);
  }
  assert.ok(castraPosture().length > 3000, '계약 본문');
  process.env.ARGO_CASTRA = '0';
  try { assert.equal(castraPosture(), '', 'ARGO_CASTRA=0 옵트아웃'); } finally { delete process.env.ARGO_CASTRA; }
});
