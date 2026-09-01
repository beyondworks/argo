// v0.1.55 실사용 제보 3건 회귀 테스트 (2026-09-01, 유건 윈도우/맥 실기기)
//  ① 새 대화가 동기화로 되살아남 — union 병합이 "비움"을 표현 못 함(재현: 로컬 0건 + 원격 851건 → 851건)
//  ② 재로그인해도 "세션 만료" 유지 — 사망 마커 해제가 갱신 성공 경로에만 있었다
//  ③ 배율 확대 시 입력창 바닥 스크롤 막대 — overflow-y만 지정하면 overflow-x가 auto로 승격된다
//  ④ 화면 줄이면 상단바 항목 겹침 — 미디어쿼리(실뷰포트 900)와 narrowBar(유효 750) 사이 사각지대
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
test('입력 textarea: overflow-x 최종 승자가 hidden — 뒤 규칙이 되돌리면 red(캐스케이드 평가)', () => {
  // '규칙이 존재한다' 단언은 캐스케이드에 fail-open이다 — 파일 끝에 같은 셀렉터로 auto를 덧쓰면
  // 수정이 무력화되는데 초록이었다(검수 FO-1 실증, MEMORY의 topbar-phone-policy 교훈 재발).
  assert.equal(effective('.input-bar textarea', 'overflow-x', 1440), 'hidden',
    'x 미지정·되돌림이면 계산값이 auto가 되어 바닥에 가로 트랙이 그려진다(실측)');
  assert.equal(effective('.input-bar textarea', 'overflow-y', 1440), 'auto', '세로 스크롤은 유지');
});

// ── ④ 상단바 겹침 ────────────────────────────────────────────────────────
test('상단바 슬롯: overflow를 걸지 않는다 — 걸면 안의 드롭다운이 클리핑돼 죽는다(검수 HIGH-1)', () => {
  // 1차 처방(overflow:hidden)이 '옆에 열기' 패널(position:absolute)을 통째로 잘라, 기본 1440폭에서도
  // 버튼이 눌려도 아무것도 안 뜨는 회귀를 만들었다. 겹침 방어는 '겹칠 대상을 먼저 치우는' 쪽으로 옮겼다.
  const w = effective('#argo-topbar-slot', 'overflow', 1440);
  assert.ok(w === undefined || w === 'visible', `슬롯 overflow는 미지정/visible이어야 한다(현재: ${w})`);
  assert.equal(effective('#argo-topbar-slot', 'min-width', 1440), '0', '슬롯 자신은 축소돼 뒤 요소를 밀지 않는다');
});
test('상단바 전환: 배율 인지 셸 판정이 미디어쿼리와 같은 임계(900)로 슬롯→밴드를 건다', async () => {
  const layout = await readFile(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8');
  // 미디어쿼리는 실뷰포트만 보므로 배율로 좁아진 750~900 구간이 사각지대였다(제보 재현: 유효 792에서 겹침)
  assert.match(layout, /toggleAttribute\('data-narrow-shell', eff < 900\)/, '유효 폭 900 임계로 data 속성 토글');
  assert.match(layout, /const eff = document\.documentElement\.clientWidth \/ z;/, '유효 폭 = clientWidth ÷ zoom');
  // 시계·버전 축은 1100 — 겹침 실측 폭(1059)보다 위로 올려 '겹칠 대상'을 먼저 치운다(검수 HIGH-1
  // 처방: 슬롯에 overflow를 걸면 안의 드롭다운이 죽으므로, 이웃을 비우는 쪽으로 방어한다).
  assert.match(layout, /setNarrowBar\(eff < 1100\)/, '시계·버전·스페이서 축(1100)');
  assert.equal(effective(':root[data-narrow-shell] #argo-topbar-slot', 'display', 1440), 'none', '배율 인지 슬롯 숨김');
  assert.equal(effective(':root[data-narrow-shell] .crew-phone-band', 'display', 1440), 'flex', '밴드 노출 — 숨기기만 하면 컨트롤 접근이 끊긴다');
  // 미디어쿼리 쪽 쌍둥이도 살아 있어야 한다(배율 1의 좁은 창 축)
  assert.equal(effective('#argo-topbar-slot', 'display', 900), 'none', '실뷰포트 축 유지(≤900)');
  // 배선(검수 FO-2·FO-3): 토글 직후 무력화·초기 판정 누락이 초록이던 구멍
  const eff = layout.slice(layout.indexOf('const check = () =>'), layout.indexOf('window.addEventListener(\'resize\', check)'));
  assert.doesNotMatch(eff, /removeAttribute\('data-narrow-shell'\)/, '판정 직후 되돌리는 코드 금지(cleanup은 이펙트 반환부에서만)');
  assert.match(layout, /check\(\);\s*\n\s*window\.addEventListener\('resize', check\);/, '초기 1회 판정 필수 — 없으면 첫 로드에서 전환이 안 걸린다');
});
