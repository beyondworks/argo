// v0.1.55 실사용 제보 3건 회귀 테스트 (2026-09-01, 유건 윈도우/맥 실기기)
//  ① 새 대화가 동기화로 되살아남 — union 병합이 "비움"을 표현 못 함(재현: 로컬 0건 + 원격 851건 → 851건)
//  ② 재로그인해도 "세션 만료" 유지 — 사망 마커 해제가 갱신 성공 경로에만 있었다
//  ③ 배율 확대 시 입력창 바닥 스크롤 막대 — overflow-y만 지정하면 overflow-x가 auto로 승격된다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-live-'));
const { mergeThread } = await import('../src/sync.mjs');
const { resetThread, appendTurn, beginTurn, loadThread, resumeSession, listArchivedSessions } = await import('../src/thread.mjs');

const buf = (o) => Buffer.from(JSON.stringify(o));
const msgs = (n, base = 1000) => Array.from({ length: n }, (_, i) => ({ who: i % 2 ? 'crew' : 'user', text: `m${i}`, ts: base + i }));

// ── ① 새 대화 부활 ────────────────────────────────────────────────────────
test('mergeThread: 리셋 tombstone이 있으면 그 이전 원격 메시지를 되살리지 않는다(제보 재현)', () => {
  const T = 5000;
  const remote = { sessionId: 's1', messages: msgs(851) };            // 아직 옛 대화를 가진 원격
  const local = { sessionId: null, messages: [], resetAt: T };        // '새 대화'가 만든 로컬
  for (const prefer of ['local', 'remote']) {
    const m = JSON.parse(mergeThread(buf(local), buf(remote), prefer).toString());
    assert.equal(m.messages.length, 0, `${prefer}: 비움이 보존돼야 한다(수정 전 851건 부활)`);
    assert.equal(m.resetAt, T, 'tombstone 보존 — 잃으면 다음 사이클에 부활이 재발한다');
  }
});
test('mergeThread: 리셋 이후 다른 기기의 새 메시지는 살아남는다(과잉 차단 금지)', () => {
  const T = 5000;
  const local = { messages: [{ who: 'user', text: '새 지시', ts: T + 100 }], resetAt: T };
  const remote = { messages: [...msgs(3), { who: 'crew', text: '다른 기기 답', ts: T + 200 }] };
  const m = JSON.parse(mergeThread(buf(local), buf(remote), 'remote').toString());
  assert.deepEqual(m.messages.map((x) => x.text), ['새 지시', '다른 기기 답'], '리셋 이후 것만 union');
});
test('mergeThread: tombstone이 없으면 기존 union 그대로(회귀 0)', () => {
  const m = JSON.parse(mergeThread(buf({ messages: [{ who: 'user', text: 'a', ts: 2000 }] }), buf({ messages: msgs(3) }), 'remote').toString());
  assert.equal(m.messages.length, 4);
  assert.ok(!('resetAt' in m), '없던 필드를 만들지 않는다');
});
test('resetThread는 tombstone을 각인하고, 이어가기(resumeSession)는 그것을 해제한다', async () => {
  const ws = 'live-reset';
  await mkdir(join(process.env.ARGO_ROOT, ws, 'chats'), { recursive: true });
  const id = await beginTurn(ws, 'pepper', { userMsg: '지시' });
  await appendTurn(ws, 'pepper', { turnId: id, userMsg: '지시', reply: '답' });
  const before = Date.now();
  await resetThread(ws, 'pepper');
  const t = await loadThread(ws, 'pepper');
  assert.equal(t.messages.length, 0);
  assert.ok(Number(t.resetAt) >= before, '리셋 시각 각인');
  // 두 번째 사이클 — 리셋 이후 쌓인 대화를 다시 리셋하면, 그 보관본에는 앞선 tombstone(T1)이 실린다.
  const id2 = await beginTurn(ws, 'pepper', { userMsg: '지시2' });
  await appendTurn(ws, 'pepper', { turnId: id2, userMsg: '지시2', reply: '답2' });
  const arch = (await loadThread(ws, 'pepper'));
  assert.ok(Number(arch.resetAt) > 0, '전제 — 활성 스레드가 T1 tombstone을 갖고 있다');
  await resetThread(ws, 'pepper'); // T2
  const t2 = Number((await loadThread(ws, 'pepper')).resetAt);
  // 이어가기 — 보관본(T1 각인 + T1~T2 사이 메시지)을 되살린다. tombstone을 안 지우면 활성에 T1이
  // 남고, 원격이 가진 최신 T2와 병합될 때 max(T1,T2)=T2가 적용돼 **되살린 메시지가 도로 잘린다**.
  const sessions = await listArchivedSessions(ws, 'pepper');
  const target = sessions.find((x) => x.id.includes('-')) ?? sessions[0];
  const restored = await resumeSession(ws, 'pepper', target.id);
  assert.ok(restored.messages.length > 0, '복원 자체는 성공');
  const after = await loadThread(ws, 'pepper');
  assert.ok(!('resetAt' in after), '이어가기는 tombstone 해제');
  // 행동으로 확인 — 원격이 최신 T2를 들고 있어도 복원분이 살아남아야 한다
  const merged = JSON.parse(mergeThread(buf(after), buf({ messages: [], resetAt: t2 }), 'local').toString());
  assert.ok(merged.messages.length > 0, '되살린 대화가 병합에서 잘리면 이어가기가 무효가 된다');
});

test('mergeThread: 리셋과 되살림은 같은 축의 사건 — 최신값이 이긴다', () => {
  const base = { messages: msgs(3, 1000) }; // ts 1000~1002
  // 되살림이 최신 → 비움 취소(복원분 생존)
  const a = JSON.parse(mergeThread(buf({ ...base, resumedAt: 6000 }), buf({ messages: [], resetAt: 5000 }), 'local').toString());
  assert.equal(a.messages.length, 3, '되살림이 리셋보다 최신이면 tombstone 미적용');
  assert.equal(a.resetAt, 5000, '두 마커 모두 보존');
  assert.equal(a.resumedAt, 6000);
  // 리셋이 최신 → 다시 비움(되살린 뒤 또 새 대화를 누른 경우)
  const b = JSON.parse(mergeThread(buf({ ...base, resumedAt: 4000 }), buf({ messages: [], resetAt: 5000 }), 'local').toString());
  assert.equal(b.messages.length, 0, '리셋이 더 최신이면 비움이 이긴다');
});

// ── ② 재로그인 세션 만료 표시 ────────────────────────────────────────────
test('saveDeviceSession(재로그인)은 사망 마커를 해제한다 — 마커가 남으면 계속 "세션 만료"가 뜬다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-'));
  const { saveDeviceSession, deviceSessionDead } = await import('../src/devicesession.mjs');
  const now = Math.floor(Date.now() / 1000);
  const sess = (t) => ({ url: 'https://x.supabase.co', anonKey: 'k', session: { access_token: t, refresh_token: 'r' + t, expires_at: now - 10, user: { id: 'u1', email: 'e' } } });
  await saveDeviceSession(sess('a1'), { root });
  await writeFile(join(root, '.device-session.json.dead'), new Date().toISOString()); // 갱신 실패가 남긴 마커
  assert.equal(deviceSessionDead({ root }), true, '전제 — 마커 상태');
  await saveDeviceSession(sess('a2'), { root }); // 재로그인
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false, '새 세션 저장 = 옛 마커 무효');
  assert.equal(deviceSessionDead({ root }), false);
});

// ── ③ 입력창 스크롤 막대 ─────────────────────────────────────────────────
test('입력 textarea: overflow-x를 hidden으로 명시 — overflow-y 단독 지정은 x를 auto로 승격시킨다', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  // 앵커는 flex 선언을 포함한 **본 규칙**으로 — '.side, .thread, … .input-bar textarea { overscroll… }'
  // 같은 공유 규칙이 먼저 잡히면 오타겟이다(이 파일에 .input-bar textarea 규칙은 3개다).
  const rule = css.match(/^\.input-bar textarea \{ flex: 1;[^}]*\}/m)?.[0];
  assert.ok(rule, '.input-bar textarea 규칙');
  assert.match(rule, /overflow-x:\s*hidden/, 'x 미지정이면 계산값이 auto가 되어 바닥에 가로 트랙이 그려진다(실측)');
  assert.match(rule, /overflow-y:\s*auto/, '세로 스크롤은 유지(6줄 초과 시 내부 스크롤)');
});
