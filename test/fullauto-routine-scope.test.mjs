// 풀 오토 모드 적용 범위 — 예약 루틴·긴 작업(분리 검수 HIGH, 총괄 결정 2026-09-26).
//
// 총괄 결정: "로컬 루틴(mirrorCtx 없음)이 주인 직접 턴으로 판정된다"는 검수 지적을 그대로
// 받아들여, **사장이 만든 로컬 루틴·장시간 작업은 풀 오토 적용 대상에 포함**한다(사용자 요청
// 취지 = "삭제·민감 변경만 빼고 모든 권한 허용"). 이 파일은 코드를 바꾸지 않고 그 판정이
// 이미 성립함을 행동으로 잠근다 — src/routines.mjs의 로컬 루틴 호출(mirrorCtx 생략 또는
// {kind:'scope', ...}, source:'routine')은 isGuestCtx(src/gateway/msgr-handoff.mjs)가
// kind !== 'msgr'라 항상 guest=false를 준다. 반대로 메신저 연동 루틴(runMessengerContinuation)은
// 원래 지시자(origin)를 그대로 복원하므로, 조직 타인이 만든 루틴은 여전히 guest=true다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fullauto-routine-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, runRoutine } = await import('../src/routines.mjs');
const { isGuestCtx } = await import('../src/gateway/msgr-handoff.mjs');

async function workspace(id) {
  const ws = `fullauto-routine-${id}`;
  await createCompany(ws, '루틴 풀오토 테스트사', 'captain');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\n---\n\n개발.\n');
  return ws;
}

test('로컬 루틴(메신저 미연동) — chat()에 넘어가는 문맥이 손님이 아니다(풀 오토 적용 대상, 조치 2)', async () => {
  const ws = await workspace(1);
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '아침 점검', prompt: '서버 상태를 확인하라', schedule: { type: 'daily', time: '09:00' } });
  let captured = null;
  const chatFn = async (_ws, slug, msg, sessionId, opts) => {
    captured = opts;
    return { reply: '점검 완료', sessionId: null, handover: null };
  };
  await runRoutine(ws, r.id, { chatFn });
  assert.ok(captured, '루틴이 chat()을 부르지 않았다');
  assert.equal(captured.source, 'routine', '루틴 호출은 source:\'routine\'이어야 한다(요구사항 2가 보는 모양)');
  // mirrorCtx는 생략되거나(알림 대상 없음) {kind:'scope', ...}다 — 둘 다 isGuestCtx에겐 '주인'이다.
  assert.equal(isGuestCtx(captured.mirrorCtx), false, '로컬 루틴이 손님으로 판정됐다 — 풀 오토 적용 대상에서 빠진다');
  if (captured.mirrorCtx) assert.notEqual(captured.mirrorCtx.kind, 'msgr', '로컬 루틴에 msgr 문맥이 실렸다면 다른 판정 경로를 타게 된다');
});

test("긴 작업(long task) 호출 모양도 같은 계약 — source:'routine' 또는 mirrorCtx 미부여 시 isGuestCtx는 항상 false", () => {
  // start_long_task(chat.mjs)가 내부적으로 만드는 후속 턴도 이 파일이 아니라 크루 도구 서버에서
  // chat()을 다시 부르는 구조라 실제 배선은 msgr-work 계열 테스트가 더 세게 잰다. 여기서는
  // "mirrorCtx가 없거나 msgr이 아니면 guest가 될 수 없다"는 이 판정의 핵심 불변식만 명시적으로 고정한다.
  assert.equal(isGuestCtx(undefined), false);
  assert.equal(isGuestCtx(null), false);
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'shared' } }), false, '루틴 알림 목적지 문맥(briefingCtx)도 손님이 아니다');
  assert.equal(isGuestCtx({ kind: 'scope', scope: { kind: 'msgr', channelId: 'x' } }), false, '메신저 채널로 브리핑하는 로컬 루틴도 손님이 아니다 — 배달 목적지일 뿐 지시자가 아니다');
});

test('메신저 연동 루틴 — 주인이 직접 만든 루틴의 후속 실행은 손님이 아니다(조치 3)', async () => {
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  const f = await msgrFixture({ requester: 'owner' });
  let captured = null;
  const runChat = async (_ws, slug, msg, sid, opts) => { captured = opts; return { reply: 'ok', sessionId: null, handover: null }; };
  await runMessengerContinuation(f.ws, 'alpha', f.origin, '후속 지시', null, { session: f.session, runChat });
  assert.ok(captured, 'runMessengerContinuation이 chat()을 부르지 않았다');
  assert.equal(isGuestCtx(captured.mirrorCtx), false, '주인이 만든 메신저 연동 루틴인데 손님으로 판정됐다');
});

test('메신저 연동 루틴 — 조직 타인이 만든 루틴의 후속 실행은 여전히 손님이다(조치 3, 풀 오토 적용 제외)', async () => {
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  const f = await msgrFixture({ requester: 'someone-else' }); // 주인(owner)이 아닌 조직 구성원이 지시
  let captured = null;
  const runChat = async (_ws, slug, msg, sid, opts) => { captured = opts; return { reply: 'ok', sessionId: null, handover: null }; };
  await runMessengerContinuation(f.ws, 'alpha', f.origin, '후속 지시', null, { session: f.session, runChat });
  assert.ok(captured, 'runMessengerContinuation이 chat()을 부르지 않았다');
  assert.equal(isGuestCtx(captured.mirrorCtx), true, '조직 타인이 시작한 루틴 후속인데 guest 사슬이 사라졌다 — 풀 오토가 잘못 적용될 수 있다');
});

/** 메신저 연동 루틴 실행 픽스처 — test/msgr-continuations.test.mjs의 setup()과 같은 최소 모양
    (실제 restoreMessengerContext가 요구하는 db·session 계약만 채운다). requester = 이 방에서
    루틴을 만든(지시한) 사람 — 'owner'면 주인, 그 외 값이면 조직 구성원(손님 판정 대상). */
let n = 0;
async function msgrFixture({ requester }) {
  const ws = `fullauto-routine-msgr-${++n}`;
  await createCompany(ws, '루틴 메신저 풀오토 테스트사', 'captain');
  await mkdir(paths(ws).agents, { recursive: true });
  const peers = [{ id: 'a', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws }];
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nslug: alpha\n---\n');
  const origin = { orgId: 'org', channelId: 'channel', crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: requester, hop: 0 };
  const db = {
    crewBySlug: async (uid, wsId, slug, orgId) => {
      const p = peers.find((p) => p.owner_user_id === uid && p.ws_id === wsId && p.slug === slug);
      return p && orgId === 'org' ? { ...p, org_id: orgId } : null;
    },
    channel: async (id) => id === 'channel' ? { id, org_id: 'org', name: '루틴 채널', kind: 'private', crew_memory: false } : null,
    org: async () => ({ id: 'org', slug: 'team' }),
    orgCrews: async () => peers,
    channelCrewMembers: async () => new Set(peers.map((p) => p.id)),
    message: async (id) => id === 10 ? { id, channel_id: 'channel', author_kind: 'user', author_user_id: requester, body: '루틴 원래 지시' } : null,
    contextOf: async () => [],
    instructCheck: async () => 'ok',
    insertMessage: async () => ({ id: 21 }),
  };
  const session = async () => ({ uid: 'owner', db });
  return { ws, origin, session };
}
