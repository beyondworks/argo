// v0.1.55 실사용 제보 3건 회귀 테스트 (2026-09-01, 유건 윈도우/맥 실기기)
//  ① 새 대화가 동기화로 되살아남 — union 병합이 "비움"을 표현 못 함(재현: 로컬 0건 + 원격 851건 → 851건)
//  ② 재로그인해도 "세션 만료" 유지 — 사망 마커 해제가 갱신 성공 경로에만 있었다
//  ③ 배율 확대 시 입력창 바닥 스크롤 막대 — overflow-y만 지정하면 overflow-x가 auto로 승격된다
//  ④ 화면 줄이면 상단바 항목 겹침 — 슬롯의 자동 최소 폭 해제가 뿌리(수용은 넘침 측정형 2단계로)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-live-'));
const { mergeThread } = await import('../src/sync.mjs');
const { resetThread, appendTurn, beginTurn, loadThread, resumeSession, listArchivedSessions } = await import('../src/thread.mjs');

// CSS 캐스케이드 승자 평가 — "규칙 존재" 단언의 fail-open을 막는다(topbar-phone-policy와 같은 계약).
// 기본 구간 + max-width:px ≥ W 블록을 소스 순서대로 걸어 대상 셀렉터의 마지막 선언을 돌려준다.
// 주석 제거(줄 구조 보존) — 주석이 셀렉터에 섞이면 정확 일치가 깨진다(topbar-phone-policy와 동일 방식).
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const cssText = stripComments(await readFile(new URL('../app/globals.css', import.meta.url), 'utf8'));
function mediaBlocks(src) {
  const out = []; const re = /@media \(max-width:\s*(\d+)px\)\s*\{/g; let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
    out.push({ px: Number(m[1]), body: src.slice(m.index + m[0].length, i - 1), start: m.index, end: i });
  }
  return out;
}
const CSS_BLOCKS = mediaBlocks(cssText);
function effective(sel, prop, W) {
  const segs = []; let cursor = 0;
  for (const b of CSS_BLOCKS) {
    if (b.start > cursor) segs.push({ applies: true, body: cssText.slice(cursor, b.start) });
    segs.push({ applies: W <= b.px, body: b.body });
    cursor = b.end;
  }
  segs.push({ applies: true, body: cssText.slice(cursor) });
  const eq = (s) => s.replace(/\s+/g, ' ').trim() === sel; // 정확 일치 — 부분 매칭은 fail-open
  let winner;
  for (const seg of segs) {
    if (!seg.applies) continue;
    for (const r of seg.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!r[1].split(',').some(eq)) continue;
      const pr = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g');
      let d; while ((d = pr.exec(r[2]))) winner = d[1].trim();
    }
  }
  return winner;
}

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
  const beforeTs = Math.max(...(await loadThread(ws, 'pepper')).messages.map((m) => Number(m.ts) || 0));
  const before = Date.now();
  await resetThread(ws, 'pepper');
  const t = await loadThread(ws, 'pepper');
  assert.equal(t.messages.length, 0);
  // 각인 = 방금 비운 대화의 마지막 ts + 1. 벽시계가 아니다(2R MEDIUM-2) — 미래 각인은 남의 메시지를 지운다.
  assert.equal(Number(t.resetAt), beforeTs + 1, '리셋 각인은 로컬이 본 것의 상한 + 1');
  assert.ok(Number(t.resetAt) <= before + 1, '각인이 벽시계를 넘어서면 안 된다');
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

test('회의 다시 열기: 되살림 각인이 없으면 되살린 회의가 다음 병합에서 통째로 잘린다(검수 2R HIGH-1)', async () => {
  const ws = 'live-room';
  await mkdir(join(process.env.ARGO_ROOT, ws, 'chats'), { recursive: true });
  const { loadRoom, endMeeting, reopenMeeting, listArchivedMeetings } = await import('../src/room.mjs');
  // saveRoom은 비공개다 — 테스트 편의로 export를 늘리지 않고 방 파일을 직접 쓴다(loadRoom이 읽는 계약).
  await writeFile(join(process.env.ARGO_ROOT, ws, 'chats', 'room-main.json'),
    JSON.stringify({ messages: [{ who: 'user', text: '안건', ts: 1000 }, { who: 'pepper', text: '답', ts: 1001 }] }));
  const ended = await endMeeting(ws);
  assert.equal(ended.archived, true);
  const t1 = Number((await loadRoom(ws)).resetAt);
  assert.ok(t1 > 0, '마치기가 tombstone을 각인한다(검수 1R MEDIUM-2)');
  const [arch] = await listArchivedMeetings(ws);
  await reopenMeeting(ws, arch.id);
  const room = await loadRoom(ws);
  assert.equal(room.messages.length, 2, '되살림 자체는 성공');
  // 원격은 아직 마치기 시점의 tombstone(t1)을 들고 있다 — 되살림 각인이 없으면 max(0,t1)=t1이 적용돼
  // 되살린 2건이 전부 잘린다. reopenMeeting은 곧바로 보관본을 지우므로 회의는 어디에도 안 남는다.
  for (const prefer of ['local', 'remote']) {
    const m = JSON.parse(mergeThread(buf(room), buf({ messages: [], resetAt: t1 }), prefer).toString());
    assert.equal(m.messages.length, 2, `${prefer}: 되살린 회의가 병합에서 잘리면 이어 말하기가 무효가 된다`);
  }
});

test('각인은 순서와 자르는 지점을 분리한다 — 시계 앞선 기기가 남의 새 메시지를 지우면 안 된다(2R M-2·3R M-1)', async () => {
  const { resetStamp, resumeStamp } = await import('../src/reset-stamp.mjs');
  const realNow = Date.now();
  const prev = { messages: [{ who: 'user', text: '옛 지시', ts: realNow - 60_000 }] };
  // ── 자르는 지점(cutTs)은 실존 ts에만 앵커 — 벽시계 미오염
  const st = resetStamp(prev);
  assert.equal(st.cutTs, realNow - 60_000 + 1, 'cutTs = 로컬이 실제로 본 것의 상한 + 1');
  const merged = JSON.parse(mergeThread(buf({ messages: [], ...st }),
    buf({ messages: [...prev.messages, { who: 'user', text: 'B의 새 지시', ts: realNow }] }), 'remote').toString());
  assert.deepEqual(merged.messages.map((m) => m.text), ['B의 새 지시'], '옛 것만 잘리고 새 메시지는 생존');
  // ── 3R MEDIUM-1 재현: 시계 +1h 기기의 되살림 → 비움 경유. 순서값(resetAt)은 벽시계를 물려받아
  //    미래로 부풀지만, 자르기는 cutTs라 상대 기기의 새 메시지가 살아남아야 한다.
  const HOUR = 3_600_000;
  const resumed = { messages: prev.messages, resumedAt: resumeStamp({}, realNow + HOUR) }; // 시계 +1h 되살림
  const st2 = resetStamp(resumed); // 그 기기에서 곧바로 새 대화
  assert.ok(st2.resetAt > resumed.resumedAt, '순서 단조 — 비움이 직전 되살림을 이겨야 tombstone이 산다');
  assert.equal(st2.cutTs, realNow - 60_000 + 1, 'cutTs는 되살림의 벽시계에 오염되지 않는다');
  const m2 = JSON.parse(mergeThread(buf({ messages: [], ...st2 }),
    buf({ messages: [...prev.messages, { who: 'user', text: 'B가 리셋 뒤 쓴 것', ts: realNow + 5_000 }] }), 'remote').toString());
  assert.deepEqual(m2.messages.map((m) => m.text), ['B가 리셋 뒤 쓴 것'],
    '수정 전: resetAt(+1h)으로 잘라 []가 됐다 — 그 메시지는 .archive에도 없다');
  // ── 병합은 cutTs를 보존한다 — 잃으면 다음 사이클이 resetAt 폴백(부풀 수 있는 값)으로 자른다
  assert.equal(m2.cutTs, st2.cutTs, 'cutTs 최신값 보존');
  // ── 구버전 blob(cutTs 부재)은 resetAt 폴백 — 옛 동작 그대로(하위 호환)
  const legacy = JSON.parse(mergeThread(buf({ messages: [], resetAt: 5000 }), buf({ messages: msgs(3) }), 'remote').toString());
  assert.equal(legacy.messages.length, 0, '구버전 tombstone도 여전히 비움을 보존한다');
});

test('빈 스레드 재비움에도 cutTs는 후퇴하지 않는다 — 후퇴하면 원 제보(851건 부활)가 재발(4R HIGH-1)', async () => {
  const ws = 'live-empty-reset';
  await mkdir(join(process.env.ARGO_ROOT, ws, 'chats'), { recursive: true });
  const id = await beginTurn(ws, 'pepper', { userMsg: '지시' });
  await appendTurn(ws, 'pepper', { turnId: id, userMsg: '지시', reply: '답' });
  await resetThread(ws, 'pepper');
  const first = await loadThread(ws, 'pepper');
  assert.ok(Number(first.cutTs) > 1, '전제 — 1차 비움이 실 ts 기반 cutTs를 각인');
  // 빈 스레드에서 한 번 더 비움 — 메인 버튼은 disabled지만 슬래시 /new와 DELETE API는 여기 도달한다.
  // lastTsOf(빈)=0이라 cutTs가 1로 후퇴하면, 1은 truthy라 resetAt 폴백(cutTs || resetAt)도 안 걸려
  // 자르기가 "ts<1" = 무효가 된다(4R 실측: 오프라인 복귀 기기의 851건이 그대로 부활).
  await resetThread(ws, 'pepper');
  const second = await loadThread(ws, 'pepper');
  assert.equal(Number(second.cutTs), Number(first.cutTs), '자르는 지점은 후퇴 금지(lastTs가 안 늘었으면 유지)');
  assert.ok(Number(second.resetAt) > Number(first.resetAt), '순서값은 단조 증가');
  const revived = JSON.parse(mergeThread(buf(second), buf({ messages: msgs(851) }), 'remote').toString());
  assert.equal(revived.messages.length, 0, '재비움 blob으로도 옛 메시지가 부활하면 안 된다');
});

test('mergeThread는 cutTs 최신값을 보존한다 — primary가 더 작아도(스프레드가 못 지키는 방향) 4R M-1', () => {
  // {...other, ...primary} 스프레드는 primary의 cutTs를 싣는다 — primary가 더 작은 값을 들면
  // 보존 줄(merged.cutTs = max) 없이는 자르기 지점이 후퇴한다(4R 하중 실증: 그 병합본으로
  // ts=150 메시지를 든 기기가 복귀하면 이미 잘린 구간이 부활).
  const m = JSON.parse(mergeThread(buf({ messages: [], resetAt: 300, cutTs: 200 }),
    buf({ messages: [], resetAt: 300, cutTs: 100 }), 'remote').toString()); // primary=remote(작은 쪽)
  assert.equal(m.cutTs, 200, 'cutTs는 스프레드 순서와 무관하게 max로 보존');
  const back = JSON.parse(mergeThread(buf(m), buf({ messages: [{ who: 'user', text: 'x150', ts: 150 }] }), 'remote').toString());
  assert.equal(back.messages.length, 0, '보존된 cutTs가 이미 잘린 구간의 부활을 막는다');
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
test('입력 textarea: overflow-x 최종 승자가 hidden — 뒤 규칙이 되돌리면 red(캐스케이드 평가)', () => {
  // '규칙이 존재한다' 단언은 캐스케이드에 fail-open이다 — 파일 끝에 같은 셀렉터로 auto를 덧쓰면
  // 수정이 무력화되는데 초록이었다(검수 FO-1 실증, MEMORY의 topbar-phone-policy 교훈 재발).
  assert.equal(effective('.input-bar textarea', 'overflow-x', 1440), 'hidden',
    'x 미지정·되돌림이면 계산값이 auto가 되어 바닥에 가로 트랙이 그려진다(실측)');
  assert.equal(effective('.input-bar textarea', 'overflow-y', 1440), 'auto', '세로 스크롤은 유지');
});

// ── ④ 상단바 겹침 ────────────────────────────────────────────────────────
// 겹침의 뿌리는 임계 폭이 아니라 **슬롯의 자동 최소 폭 해제**였다(분리 검수 2R HIGH-2 실측:
// min-width:0이면 슬롯 박스만 0까지 줄고 자식(flex:none)이 버전·시계 위에 덮어 그려진다 —
// 영어 UI 유효폭 1100에서 62px, 긴 라벨 1200에서 43px). 자동 최소 폭을 살려 두면 겹침이
// 구조적으로 불가능해지고, 수용은 넘침 측정으로 단계 전환한다.
test('상단바 슬롯: min-width도 overflow도 걸지 않는다 — 둘 다 결함의 직접 원인이었다', () => {
  // min-width:0 → 겹침(2R HIGH-2) · overflow:hidden → 안의 드롭다운이 클리핑돼 죽음(1R HIGH-1).
  // 두 속성 모두 "선언이 없어야" 통과 — 값 지정은 어느 쪽이든 결함을 되돌린다.
  for (const [prop, why] of [['min-width', '자동 최소 폭을 해제하면 자식이 이웃 위에 덮어 그려진다'],
                             ['overflow', '절대배치 드롭다운 패널이 슬롯에 잘려 버튼이 무동작이 된다']]) {
    for (const W of [1440, 900, 560]) {
      const v = effective('#argo-topbar-slot', prop, W);
      assert.ok(v === undefined || v === 'visible', `W=${W}: 슬롯 ${prop} 미지정이어야 한다(현재 ${v}) — ${why}`);
    }
  }
});
test('검색 pill 플로어(96px)는 base 규칙이 전 구간 보장한다 — 접기 속성에 묶으면 순환(3R HIGH-1)', () => {
  // 3R HIGH-1: 플로어를 :root[data-narrow-bar]에만 걸면 순환이 된다 — base 0이면 pill이 부족분을
  // 전부 흡수해 넘침(= 접기 트리거)이 발생하지 않고, 그래서 플로어도 켜지지 않아 입력이 죽는
  // 구간(유효 990~950, 앱 최소 창폭 960 포함)에서 정확히 방어가 침묵한다. base 96px면 pill의
  // "더는 못 줄인다"가 곧 fitBar의 정직한 넘침 신호가 된다(3R 실측: 1440→540 전 구간 넘침 0,
  // 입력 최솟값 49px). #340의 넘침은 이제 접기 기구가 흡수하므로 base 플로어 금지 근거가 소멸했다.
  // 참고: 이 평가기는 명시도를 모른다(소스 순서만 — 3R LOW-2). 지금은 후보 규칙이 base 하나뿐이라
  // 성립하며, .search-pill min-width를 다른 셀렉터로 재선언하는 순간 이 핀의 전제부터 재검토할 것.
  for (const W of [1440, 960, 900, 561, 560, 375]) {
    assert.equal(effective('.search-pill', 'min-width', W), '96px', `W=${W}: 플로어가 전 구간 살아 있어야 한다`);
  }
  // 부정 스위프(4R LOW-2 실증): 이 평가기는 명시도를 모른다 — :root[data-theme='x'] .search-pill 같은
  // 명시도 높은 규칙이 min-width:0을 재선언하면 브라우저에선 그쪽이 이겨 그 테마에서만 입력 0px가
  // 부활하는데, 위 단언은 초록이었다. pill 자신을 대상으로 하는 규칙 중 base 단독 규칙 외에는
  // min-width 선언 자체를 금지한다(플로어의 진실 원천은 한 곳).
  let baseDecl = 0;
  for (const r of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const hitsPill = r[1].split(',').some((sel) => /(^|[\s>+~])\.search-pill$/.test(sel.trim()));
    if (!hitsPill || !/min-width\s*:/.test(r[2])) continue;
    const isBase = r[1].split(',').some((sel) => sel.trim() === '.search-pill');
    assert.ok(isBase, `pill 대상 min-width는 base 규칙에서만: "${r[1].trim().slice(0, 60)}"`);
    baseDecl += 1;
  }
  assert.equal(baseDecl, 1, 'base .search-pill의 min-width 선언은 정확히 1곳');
});
test('접기 1단계(data-narrow-bar): 정보 가치 낮은 축만 접고 남는 폭을 검색으로 보낸다', () => {
  for (const sel of [':root[data-narrow-bar] .topbar-spacer', ':root[data-narrow-bar] .topbar-clock',
                     ':root[data-narrow-bar] .topbar-ver', ':root[data-narrow-bar] .topbar-upd']) {
    assert.equal(effective(sel, 'display', 1440), 'none', `${sel} 접힘`);
  }
  assert.equal(effective(':root[data-narrow-bar] .search-pill', 'flex', 1440), '1', '접은 폭은 검색으로');
  // 작업 도크는 접지 않는다 — 우선순위 정책상 기능(도크) > 정보(시계·버전)
  assert.equal(effective(':root[data-narrow-bar] #argo-topbar-slot', 'display', 1440), undefined,
    '1단계에서 슬롯을 접으면 2단계와 구분이 없어진다');
});
test('접기 2단계(data-narrow-shell): 슬롯을 인라인 밴드로 내린다 — 실뷰포트 축 쌍둥이도 유지', () => {
  assert.equal(effective(':root[data-narrow-shell] #argo-topbar-slot', 'display', 1440), 'none');
  assert.equal(effective(':root[data-narrow-shell] .crew-phone-band', 'display', 1440), 'flex',
    '밴드 노출 — 숨기기만 하면 컨트롤 접근이 끊긴다');
  assert.equal(effective('#argo-topbar-slot', 'display', 900), 'none', '미디어쿼리 쌍둥이 유지(배율 1의 좁은 창)');
});
test('배선: fitBar는 매번 가장 넓은 상태에서 재측정하고 2단계로만 올라간다(래칫 금지)', async () => {
  const layout = await readFile(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8');
  const i0 = layout.indexOf('const fitBar = useCallback(');
  assert.ok(i0 > 0, 'fitBar 존재');
  const body = layout.slice(i0, layout.indexOf('}, []);', i0));
  // 순서 불변식 — 낱개 문자열 핀은 순서를 못 지킨다(MEMORY: 삼항 순서 뒤집기 fail-open). 인덱스로 본다.
  const iClrBar = body.indexOf("removeAttribute('data-narrow-bar')");
  const iClrShell = body.indexOf("removeAttribute('data-narrow-shell')");
  const iSetBar = body.indexOf("setAttribute('data-narrow-bar'");
  const iSetShell = body.indexOf("setAttribute('data-narrow-shell'");
  assert.ok(iClrBar >= 0 && iClrShell >= 0, '측정 전 두 단계 모두 되돌려야 한다');
  assert.ok(iSetBar > iClrBar && iSetBar > iClrShell, '되돌림이 판정보다 먼저 — 아니면 접힌 상태를 재어 못 돌아온다');
  assert.ok(iSetShell > iSetBar, '2단계는 1단계 뒤에만');
  assert.match(body, /scrollWidth > bar\.clientWidth/, '판정 기준은 실제 넘침(임계 폭 금지 — 마법수는 언어·라벨을 못 따라간다)');
  assert.doesNotMatch(body, /clientWidth \/ z|eff <|narrowBar/, '옛 임계 판정이 남아 있으면 두 축이 갈라진다');
  // 등록 — 관찰기(슬롯 내용 변화)와 창/배율 이벤트 둘 다. 하나라도 빠지면 낡은 판정이 남는다.
  assert.match(layout, /new ResizeObserver\(fitBar\)/, '슬롯·상단바 크기 관찰');
  assert.match(layout, /getElementById\('argo-topbar-slot'\);\s*\n\s*if \(slot\) ro\.observe\(slot\)/, '슬롯 관찰 — 포털 내용이 늦게 온다');
  assert.match(layout, /window\.addEventListener\('argo:zoom', fitBar\)/, '표시 배율 변경 축');
  assert.match(layout, /fitBar\(\);\s*\n\s*\/\/ 슬롯은 크루 페이지가/, '초기 1회 판정 필수');
  // 언어 재판정(3R MEDIUM-2 — 4R에서 deps 변이 초록 실증 후 핀): stage 2에선 슬롯이 display:none이라
  // RO의 내용 감지가 죽는다. 언어 전환(라벨 폭 축소)이 재판정을 부르려면 재측정 effect deps에 lang.
  assert.match(layout, /useEffect\(\(\) => \{ fitBar\(\); \}, \[fitBar, lang, title, appVersion, updateVersion\]\)/,
    '재측정 deps에서 lang이 빠지면 en→ko 전환 후 과접힘이 굳는다(4R 실측: stage 2 고착, 강제 재판정 시 1)');
  // JSX — 접기는 CSS가 한다(React 조건부면 ①단계 되돌림이 동기적으로 성립하지 않는다)
  assert.match(layout, /<header className="topbar" ref=\{barRef\}>/, '측정 대상 참조');
  assert.match(layout, /className="chip mono topbar-upd"/, '업데이트 칩에 접기용 클래스');
  assert.doesNotMatch(layout, /\{!narrowBar &&/, 'narrowBar 조건부 렌더 잔존 금지');
  assert.match(layout, /<label className="search-pill">/, 'pill 인라인 스타일 제거 — flex 전환은 CSS가');
});
test('밴드 진입로: 분할 패널이 살아 있는 축과 정확히 같은 조건으로 노출한다(검수 MEDIUM-1)', async () => {
  const page = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  // 질의는 CSS 규칙의 여집합 — min-width:900으로 쓰면 소수점 뷰포트(899.4)에서 둘 다 거짓이 된다(2R LOW-1)
  assert.match(page, /matchMedia\('\(max-width: 899px\)'\)/, '.split-pane을 죽이는 규칙과 같은 질의');
  assert.match(page, /setSplitAlive\(!mq\.matches\)/, '여집합 — 부정을 빠뜨리면 판정이 뒤집힌다');
  assert.equal(effective('.split-pane', 'display', 899), 'none', '전제 — CSS가 899px에서 패널을 죽인다');
  // 배선(2R MEDIUM-1: 이 블록을 통째로 지워도 스위트가 초록이었다) — 밴드 구간 안에 있어야 한다
  const bi = page.indexOf('"crew-phone-band"');
  const band = page.slice(bi, page.indexOf('<div className="thread"', bi));
  assert.match(band, /\{!embedded && splitAlive && \(\s*\n\s*<SideOpenMenu/, '밴드 안에 splitAlive 조건부 진입로');
  assert.match(page, /const \[splitAlive, setSplitAlive\] = useState\(true\)/, '초기값 true — false면 넓은 폭 첫 프레임에 진입로가 없다');
});
test('밴드 진입로 패널: 뷰포트 클램프 — 오른쪽 끝 트리거에서 문서 가로 넘침을 만들지 않는다', async () => {
  const page = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  const i0 = page.indexOf('function SideOpenMenu(');
  const body = page.slice(i0, page.indexOf('\n}', i0));
  // 슬롯(왼쪽)에만 있을 땐 안 뚫렸는데 밴드로 내려오며 트리거가 우측 끝에 설 수 있게 됐다
  // (실측: 배율 2 × 1424에서 패널 right 1441 > clientWidth 1424 → 문서 가로 스크롤 17px).
  assert.match(body, /dropUpClamp\(boxRef\.current\.getBoundingClientRect\(\),\s*document\.documentElement\.clientWidth/,
    '클램프 입력은 clientWidth — 100vw는 스크롤바 폭만큼 샌다(#359 교훈)');
  assert.match(body, /left: clamp\.shift/, '시프트가 실제로 위치에 적용돼야 한다');
  assert.match(body, /maxWidth: clamp\.maxW \|\| undefined/, '상한 미적용 시 자연 폭 보존(1회 실측 전제)');
  assert.match(body, /useIsoLayoutEffect/, 'layout effect — useEffect면 클램프 전 프레임이 문서 폭을 늘린다');
  assert.match(body, /if \(!naturalW\.current\) naturalW\.current = panelRef\.current\.offsetWidth/,
    '자연 폭은 1회만 — 상한 걸린 뒤 재측정하면 왕복 복원이 깨진다');
  assert.match(body, /window\.addEventListener\('argo:zoom', measure\)/, '열린 채 배율이 바뀌면 시프트가 낡는다');
});
