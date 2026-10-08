// 능동 비서 1단계(feat/assistant-engine-calendar)가 손대는 자리의 **옆 행동**을 먼저 잠근다(Argo CLAUDE.md "인접 회귀 방지" 2).
// 이 파일의 단언은 전부 지금 동작(origin/main)이다 — 비서 코드가 들어온 뒤에도 그대로 초록이어야 한다.
//  ① 동기화 제외 목록(EXCLUDE): .assistant/ 한 줄을 더해도 기존 제외·포함이 바뀌지 않는다. assistant.json(설정)은 동기화 대상이다.
//  ② 동기화의 파일 잠금 목록(isFileLockedRel): assistant.json을 더해도 기존 파일·스레드 판정이 그대로다.
//  ③ 리스 획득·양보 판정: 리스 글에 칸 하나를 더하고 보유자 정보를 기억해도 leader·ownedAt·checkedAt 전이와 쓰기 횟수가 그대로다.
//  ④ 설정 화면의 알림 체크박스: 메신저 알림 종류에 'assistant'를 더해도 체크박스 판정(notifyChannelState)·텔레그램/슬랙 끄기 목록·
//     기존 종류의 1:1 알림 판정이 그대로다.
// 스케줄러 틱의 루틴·우편·검진·정리 호출은 test/scheduler-tick-wiring.test.mjs가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-pins-'));
process.env.ARGO_SYNC = '1';
// 봉투 암호화 스위치를 끈다 — 켜져 있으면 계정 키가 없는 이 프로세스에서는 모든 경로가 "키 미확보 불가시"로 제외돼(EXCLUDE 끝 줄),
// 아래 ①이 보려는 구조적 제외 규칙이 가려진다. 구조적 규칙은 스위치와 무관하게 먼저 평가된다(EXCLUDE 머리 주석의 순서 불변식).
process.env.ARGO_ENC_VAULT = '0';
delete process.env.ARGO_PREFER_LEADER;
delete process.env.ARGO_NO_LEADER;

const { EXCLUDE, isFileLockedRel, isThread, renewLease, _setSyncClientForTest, LEASE_TTL_MS } = await import('../src/sync.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');
const { CHANNEL_EVENTS, normalizeMuted } = await import('../src/channel-events.mjs');
const { notifyChannelState, msgrNotifyWants, formatMsgrNotify } = await import('../src/msgr-notify.mjs');

test('① 동기화 제외 목록 — 지금 제외하는 것은 계속 제외, 동기화하는 것은 계속 동기화', () => {
  const excluded = [
    'mail/alpha/1.json', 'sessmsg/x.json', '.sessions/native/a.json', '.msgr-journal/x.md', 'vault/org/o/rules/a.md',
    '.gw-queue-telegram/1.json', '.gateway-telegram.json', '.gw-offset-telegram', '.sync-state.json', '.device-id',
    '.runner-health.json', '.workroots.json', '.connector-secrets.json', 'chats/alpha.status.json', 'x.lock',
    '.tmp-company.json-1-abc', 'routines.json.corrupt-123', '.local-assets/a', '.index.sqlite', '.DS_Store',
  ];
  for (const rel of excluded) assert.equal(EXCLUDE(rel), true, `${rel}는 지금 동기화하지 않는다`);
  const synced = [
    'company.json', 'routines.json', 'corrections.json', 'approvals.json', 'capabilities.json', 'agents/alpha.md',
    'chats/alpha.json', 'vault/notes/a.md', 'vault/journal/2026-10-08.md', 'usage.jsonl', 'events.jsonl',
    '.failure-digest.json', // 회사의 사실 — 리더가 바뀌어도 같은 서명을 다시 보고하지 않게 동기화(#446 D12)
    'assistant.json', // 비서 설정은 기기 사이 같은 설정이어야 한다(설계 4.4) — 지금도 동기화 대상이고 앞으로도 그렇다
    'assistant/notes.md', // 점 없는 같은 이름 폴더는 사용자 자료다 — 비서 상태 폴더(.assistant)와 섞이지 않는다
  ];
  for (const rel of synced) assert.equal(EXCLUDE(rel), false, `${rel}는 지금 동기화한다`);
});

test('② 동기화 파일 잠금 목록 — 지금 잠그는 파일은 그대로, 스레드는 스레드 잠금(isThread) 쪽', () => {
  for (const rel of ['company.json', 'approvals.json', 'corrections.json', 'routines.json', 'connections.json', 'agents/alpha.md']) {
    assert.equal(isFileLockedRel(rel), true, `${rel}는 프로세스 간 잠금 대상`);
  }
  for (const rel of ['chats/alpha.json', 'vault/notes/a.md', 'mcp.json', 'capabilities.json', 'agents/sub/a.md', 'usage.jsonl', 'x/company.json']) {
    assert.equal(isFileLockedRel(rel), false, `${rel}는 이 목록 밖`);
  }
  assert.equal(isThread('chats/alpha.json'), true);
});

/* ── ③ 리스 — leader-yield.test.mjs와 같은 가짜 저장소(업로드·다운로드만 흉내) ── */
const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, download: 0, docs: [] };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      calls.download += 1;
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) {
      calls.upload += 1;
      stored = Buffer.from(await blob.arrayBuffer());
      calls.docs.push(JSON.parse(stored.toString()));
      return { data: {}, error: null };
    },
  };
  return { client: { storage: { from: () => bucket } }, calls };
};
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
const setLease = (patch) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0 }, patch);

test('③-a 빈 리스 획득 — 리더·확인된 보유(ownedAt)·확인 시각이 서고, 리스 글에 deviceId·token·ts가 있다(우선 기기 표지는 없다)', async () => {
  const me = await getDeviceId();
  const { client, calls } = fakeClient(null);
  _setSyncClientForTest(client);
  setLease({});
  const t0 = Date.now();
  await renewLease('owner-pin-a', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.ok(lease().ownedAt >= t0, '확인된 획득만 보유 시각을 남긴다');
  assert.ok(lease().checkedAt >= t0);
  assert.equal(calls.upload, 1, '획득은 쓰기 한 번');
  const doc = calls.docs[0];
  assert.equal(doc.deviceId, me);
  assert.equal(typeof doc.token, 'string');
  assert.ok(Number.isFinite(doc.ts));
  assert.equal('preferred' in doc, false, '우선 기기가 아니면 preferred 칸이 없다');
});

test('③-b 다른 기기가 쥔 새 리스 — 양보(리더 아님·보유 0·확인 시각 갱신·쓰기 0)', async () => {
  const { client, calls } = fakeClient({ deviceId: 'other-device-pin', token: 't', ts: Date.now() });
  _setSyncClientForTest(client);
  setLease({ leader: true, ownedAt: 0, checkedAt: 0 });
  const t0 = Date.now();
  await renewLease('owner-pin-b', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(lease().ownedAt, 0);
  assert.ok(lease().checkedAt >= t0, '양보도 확인 시각을 남긴다');
  assert.equal(calls.upload, 0);
});

test('③-c 확인된 보유자가 30초 안 — 쓰지 않고 확인 시각만 갱신, 보유 시각은 그대로', async () => {
  const me = await getDeviceId();
  const { client, calls } = fakeClient({ deviceId: me, token: 't0', ts: Date.now() });
  _setSyncClientForTest(client);
  const owned = Date.now() - 5_000;
  setLease({ leader: true, ownedAt: owned, checkedAt: 0 });
  await renewLease('owner-pin-c', { runnerUsable: true });
  assert.equal(calls.upload, 0);
  assert.equal(lease().leader, true);
  assert.equal(lease().ownedAt, owned);
  assert.ok(lease().checkedAt > 0);
});

test('③-d 다른 기기의 만료된 리스 — 획득(쓰기 1)', async () => {
  const { client, calls } = fakeClient({ deviceId: 'other-device-pin', token: 't', ts: Date.now() - LEASE_TTL_MS - 1_000 });
  _setSyncClientForTest(client);
  setLease({ leader: false, ownedAt: 0 });
  await renewLease('owner-pin-d', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(calls.upload, 1);
});

test('④ 설정 화면 알림 체크박스 — 메신저 체크는 notify 모드만 보고, 텔레그램·슬랙 끄기 목록과 기존 종류 판정은 그대로', () => {
  // 아르고 메신저 체크박스는 notify 모드 하나로 켜짐을 정한다 — 종류별 끈 목록(msgr.mutedEvents)이 무엇이든 체크 표시는 바뀌지 않는다
  const on = notifyChannelState({ company: { msgr: { enabled: true, notify: { mode: 'dm' }, mutedEvents: ['approval', 'routine'] } }, signedIn: true });
  assert.deepEqual(on.msgr, { connected: true, on: true, signedIn: true });
  const off = notifyChannelState({ company: { msgr: { enabled: true, mutedEvents: [] } }, signedIn: true });
  assert.deepEqual(off.msgr, { connected: true, on: false, signedIn: true });
  // 텔레그램·슬랙 "끄기"는 그 채널 종류 전부를 끈 목록에 쓴다(msgr/notify 라우트) — 이 목록은 비서와 무관하게 그대로다
  assert.deepEqual([...CHANNEL_EVENTS.telegram], ['approval', 'routine', 'job', 'crewmail', 'inbox']);
  assert.deepEqual([...CHANNEL_EVENTS.slack], ['approval', 'routine']);
  const tgOff = notifyChannelState({ connections: { telegram: { enabled: true, token: 'x', chatId: 1, mutedEvents: [...CHANNEL_EVENTS.telegram] } }, signedIn: true });
  assert.deepEqual(tgOff.telegram, { connected: true, on: false });
  // 메신저 1:1 알림의 기존 종류는 그대로 간다(끈 목록에 든 것만 빠진다)
  for (const type of ['approval', 'delegate', 'crewmail', 'routine', 'job']) {
    assert.equal(msgrNotifyWants({ mode: 'dm' }, { type }), true, `${type}는 지금처럼 1:1 알림 대상`);
    assert.equal(msgrNotifyWants({ mode: 'dm' }, { type }, [type]), false, `${type}를 끄면 빠진다`);
    assert.deepEqual(normalizeMuted('msgr', [type]), [type], `${type} 끄기가 저장에서 살아남는다`);
  }
  // 알림 버스(emitNotify)의 1:1 알림 글은 모르는 종류에 본문을 만들지 않는다 — 비서 글이 이 경로로 한 번 더 올라가지 않는다
  assert.equal(formatMsgrNotify({ type: 'assistant' }, 'ko'), '');
});
