// 가만히 있어도 DB 요청이 분당 약 52건 나가던 결함(기능 점검 D2, 2026-10-02) — 주기 호출을 없애고 바뀐 것이 있을 때만 부른다.
// 원칙: 방송으로 알 수 있는 것은 방송을 받았을 때만, 방송이 없는 것(친구·차단·설정·목록)은 앞으로 올 때·재연결 때·그 화면에 들어갈 때만(syncEpoch).
// 실측은 ego로(보고서: 폰 가만히 65초 REST 0건, presence 제외). 이 테스트는 주기 호출이 다시 들어오는 길을 막는다:
//   ① 15초 tick은 화면 다시 그리기 시계일 뿐 — 네트워크 효과의 의존 배열에 넣지 않는다. ② setInterval은 아래 허용 목록(이유 포함)만.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/', import.meta.url);
const app = readFileSync(new URL('App.jsx', dir), 'utf8');

test("tick은 네트워크 효과의 의존 배열에 없다 — 화면 계산(얼굴 상태 useMemo)만 쓴다", () => {
  const deps = [...app.matchAll(/\}, \[([^\]]*)\]\)/g)].filter((m) => /\btick\b/.test(m[1])).map((m) => m[1].trim());
  assert.deepEqual(deps, ['avatars, crews, myAvailable, myAgents, looks, typing, inbox, approvals, doneAt, surprisedAt, erroredAt, tick'], deps.join(' | '));
  assert.doesNotMatch(app, /tick % 2/, '30초 목록 다시 읽기 없음');
  assert.doesNotMatch(app, /\$\{tick\}|=\{tick\}/, 'tick을 자식에게 다시 읽기 신호로 넘기지 않는다(방 설정 시트가 15초마다 넣기 요청을 읽던 것)');
});

test('setInterval은 허용 목록뿐 — 새 주기 호출은 이유와 함께 여기에 올린다', () => {
  const allowed = [
    [/setInterval\(\(\) => setTick\(\(x\) => x \+ 1\), 2000\)/, '입력 중 표시 내리기(화면만, 입력 중일 때만)'],
    [/setInterval\(\(\) => setAwaitTick\(\(x\) => x \+ 1\), 5000\)/, '보낸 뒤 대기 표시 단계 전환(화면만, 대기 표시가 있을 때만 — 2026-10-05)'],
    [/setInterval\(\(\) => setTick\(\(x\) => x \+ 1\), 15_000\)/, '시각 표시 다시 그리기(화면만 — 네트워크 효과는 tick에 묶지 않는다)'],
    [/if \(!onScreen \|\| !rtDown\) return undefined; const iv = setInterval\(/, '보이는 방에서 실시간이 끊겼다고 알려진 동안만 보정 조회'],
    [/if \(!onScreen\) return undefined; const iv = setInterval\(\(\) => \{ const \{ msgs: ms, atts: at \} = live\.current; const miss/, '빈 첨부·반응이 있을 때만 메우기(없으면 요청 0)'],
    [/if \(!nodeOn \|\| channel\.kind === 'dm'\) return; loadRequests\(\)\.catch\(\(\) => \{\}\); const iv = setInterval\(/, '방 설정 시트를 연 동안 노드의 크루 만들기 요청 진행(시트를 닫으면 멈춘다)'],
    [/const iv = setInterval\(async \(\) => \{\n\s*const \{ data, error \} = await supabase\.from\('msgr_server_links'\)/, 'VPS 연결을 진행하는 동안만(연결 끝·만료면 멈춘다)'],
  ];
  const found = [...app.matchAll(/setInterval\(/g)].length;
  const hits = allowed.filter(([re]) => re.test(app)).length;
  assert.equal(found, allowed.length, `App.jsx setInterval ${found}개 — 허용 목록 ${allowed.length}개와 다르다`);
  assert.equal(hits, allowed.length, '허용 목록의 모양이 바뀌었다');
  // 다른 파일: 앱 업데이트 확인(DB 아님, 30분 간격 판정)·업무 패널(열린 동안만)
  for (const f of readdirSync(dir).filter((x) => /\.jsx$/.test(x) && x !== 'App.jsx')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const n = [...src.matchAll(/setInterval\(/g)].length;
    const ok = { 'update.jsx': 1, 'mobile-update.jsx': 1, 'work-panel.jsx': 3 }[f] ?? 0;
    assert.equal(n, ok, `${f}: setInterval ${n}개(허용 ${ok})`);
  }
});

test('읽음 커서는 마지막으로 쓴 값보다 클 때만 쓴다(초점·가시성이 바뀔 때마다 upsert하던 것)', () => {
  assert.match(app, /if \(!channelId \|\| !lastId \|\| \(readMark\.current\[channelId\] \?\? 0\) >= lastId\) return; readMark\.current\[channelId\] = lastId;/);
});

test('구독은 내가 속한 조직 전체 + u:를 한 번 — 탭·고른 조직이 바뀌어도 다시 걸지 않는다(D3), 방 토픽도 공간을 오가며 유지', () => {
  assert.match(app, /\}, \[orgSubKey, hasToken\]\);/); // 키 = orgSubscriptionKey(uid·조직 집합·복귀·전체 해제 — realtime-link.test.mjs)
  assert.doesNotMatch(app, /\}, \[orgId, session\.access_token, resumeEpoch\]\);/, '지금 조직만 구독하던 효과는 없다');
  assert.match(app, /\(ready && spaces\.get\(id\) === space && !want\.has\(id\)\)/, '방 토픽은 지금 공간에서 빠진 방만 뗀다');
  assert.match(app, /\) : isPhone && page !== 'chat' \? null/, '폰 목록 뒤에 숨은 대화방을 그리지 않는다');
});
