// 회의실 진행 마커 — 유건 실사용 제보(2026-09-02): 안건을 올리고 다른 페이지에 갔다 오면 '회의 중' 표시가
// 사라져 멈춘 것처럼 보였다. 원인 = 표시가 자기 탭의 POST 대기(busy)뿐, 서버 진행 상태를 읽어 복원하는
// 경로 부재. 처방 = 크루 채팅의 상태 파일 계약(turn-status.mjs)을 슬러그 'room-main'으로 재사용 +
// GET /room이 turn을 동봉 + 페이지가 serverBusy로 복원(busy와 분리 — 폴링이 멈추지 않게).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-roomstatus-')); // 워크스페이스 임포트보다 먼저
delete process.env.NEXT_PUBLIC_SUPABASE_URL; // AUTH off — 라우트 실호출이 guardCompany를 지나게(apimsg 테스트 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { paths } = await import('../src/workspace.mjs');
const { setTurnStatus, clearTurnStatus, getTurnStatus } = await import('../src/turn-status.mjs');
const { withRoomTurnStatus, getRoomTurn, ROOM_TURN_SLUG } = await import('../src/room.mjs');

// 소스 핀은 주석을 벗기고 본다 — 주석 속 문구가 앵커에 걸리면 fail-open(레포 관례: display-zoom-layout 등)
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));

async function seed(ws) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [{ who: 'user', text: '안건', ts: 1 }], sid: 1 }));
  return p;
}
const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
const backdate = async (ws, slug, ageMs) => {
  // 원자 교체(tmp+rename) — 진행 중 하트비트의 읽기와 겹쳐도 빈 파일을 보이지 않는다(윈도우 CI 실사고)
  const f = statusPath(ws, slug); const s = JSON.parse(await readFile(f, 'utf8'));
  const tmp = `${f}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify({ ...s, ts: Date.now() - ageMs }));
  await (await import('node:fs/promises')).rename(tmp, f);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('withRoomTurnStatus: 턴 동안 마커가 살아 있고, 끝나면(성공·예외 모두) 해제된다', async () => {
  const ws = 'rs-life'; await seed(ws);
  let during = null;
  const out = await withRoomTurnStatus(ws, async () => { during = await getRoomTurn(ws); return 'ok'; });
  assert.equal(out, 'ok', '반환값 투과');
  assert.equal(during?.active, true, '턴 중에는 진행 중');
  assert.equal(await getRoomTurn(ws), null, '정상 종료 후 해제');
  await assert.rejects(withRoomTurnStatus(ws, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await getRoomTurn(ws), null, '예외로 끝나도 해제 — 남으면 화면이 영구히 회의 중');
});

test('withRoomTurnStatus: 하트비트가 마커를 주기 갱신하고 발언자를 보존한다 — 이벤트 없는 긴 단계에서도 표시 유지', async () => {
  const ws = 'rs-hb'; await seed(ws);
  let inside = null;
  await withRoomTurnStatus(ws, async (mark) => {
    await mark('pepper'); // 발언자 갱신(루프가 하는 일) — 래퍼의 mark만이 하트비트와 값을 공유한다
    await backdate(ws, ROOM_TURN_SLUG, 100_000);               // 100초 전 — 아직 2분 창 안(하트비트가 읽을 수 있게)
    await sleep(180);                                          // 하트비트 40ms × 여러 회
    inside = await getTurnStatus(ws, ROOM_TURN_SLUG);
  }, { heartbeatMs: 40 });
  assert.ok(inside && Date.now() - inside.startedAt < 60_000, '전제 — 마커가 살아 있다');
  const raw = JSON.parse(await readFile(statusPath(ws, ROOM_TURN_SLUG), 'utf8').catch(() => 'null'));
  assert.equal(raw, null, '종료 후 마커 소멸');
  assert.equal(inside.detail, 'pepper', '하트비트가 발언자(detail)를 지우면 표시의 발언자 정보가 사라진다');
});

test('하트비트는 파일을 다시 읽지 않는다 — 인계 직후 틱이 옛 발언자를 되살리지 않는다(검수 LOW-1·윈도우 빈 읽기 실사고)', async () => {
  const ws = 'rs-hb-mem'; await seed(ws);
  let stale = 0;
  await withRoomTurnStatus(ws, async (mark) => {
    for (let i = 0; i < 60; i++) {
      await mark('a|b'); await mark('b|');
      await sleep(2);
      if ((await getTurnStatus(ws, ROOM_TURN_SLUG))?.detail !== 'b|') stale += 1;
    }
  }, { heartbeatMs: 1 });
  assert.equal(stale, 0, `인계 뒤 옛 발언자 부활 ${stale}/60 — 하트비트가 파일을 읽어 되쓰면 생긴다`);
  const src = stripComments(await readFile(new URL('../src/room.mjs', import.meta.url), 'utf8'));
  const wrap = src.slice(src.indexOf('export async function withRoomTurnStatus('), src.indexOf('export async function getRoomTurn'));
  assert.doesNotMatch(wrap, /getTurnStatus\(/, '래퍼(하트비트)에 파일 읽기 금지');
  assert.match(wrap, /const write = \(\) => setTurnStatus\(wsId, ROOM_TURN_SLUG, 'room', ROOM_MARK\.get\(wsId\) \?\? ''\);/, '실행 시점 메모리 값을 쓴다');
  assert.match(wrap, /const mark = async \(detail\) => \{ ROOM_MARK\.set\(wsId, detail\); tick = tick\.then\(write\)/, 'mark도 같은 체인 — 따로 쓰면 오래된 스냅샷이 나중에 착지한다');
  assert.match(wrap, /const beat = \(\) => \(alive \? write\(\) : undefined\);/, '하트비트 = 같은 write');
});

test('해제 경합: 진행 중 틱이 해제 뒤 마커를 되살리지 않는다(heartbeatMs 1 × 40회 — 검수 HIGH-1 비플레이키 핀)', async () => {
  // `await tick`이 빠지면 틱(비동기 읽기→쓰기)이 clearTurnStatus 뒤에 착지해 마커가 부활한다.
  // 검수 실측: 출하본 0/40, 변이본 37/40 — 단일 실행·느긋한 대기로는 1/11밖에 못 잡던 구멍.
  const ws = 'rs-race'; await seed(ws);
  let revived = 0;
  for (let i = 0; i < 40; i++) {
    await withRoomTurnStatus(ws, async () => { await sleep(3); }, { heartbeatMs: 1 });
    await sleep(30);
    if (existsSync(statusPath(ws, ROOM_TURN_SLUG))) { revived += 1; await clearTurnStatus(ws, ROOM_TURN_SLUG); }
  }
  assert.equal(revived, 0, `해제 뒤 마커 부활 ${revived}/40 — 화면이 2분간 거짓 '회의 중'이 된다`);
});

test('동시 턴: 같은 방의 두 턴이 겹치면 마지막 턴이 끝날 때만 마커를 지운다(검수 MEDIUM-1)', async () => {
  const ws = 'rs-two'; await seed(ws);
  let afterFirst = null;
  const a = withRoomTurnStatus(ws, async () => { await sleep(60); });
  const b = withRoomTurnStatus(ws, async () => { await sleep(200); });
  await a; afterFirst = await getRoomTurn(ws);
  assert.equal(afterFirst?.active, true, '먼저 끝난 턴이 지우면 뒤 턴이 도는 동안 표시가 꺼진다');
  await b;
  assert.equal(await getRoomTurn(ws), null, '둘 다 끝나면 해제');
});

test('getRoomTurn: 신선한 마커=진행 중, 낡은 마커=null, 없음=null — 발언자 폴백 없음(검수 HIGH-2)', async () => {
  const ws = 'rs-fresh'; await seed(ws);
  assert.equal(await getRoomTurn(ws), null, '마커 없음');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  assert.deepEqual((({ active, slug }) => ({ active, slug }))(await getRoomTurn(ws)), { active: true, slug: 'pepper' }, '신선한 마커');
  await backdate(ws, ROOM_TURN_SLUG, 5 * 60_000);
  await setTurnStatus(ws, 'pepper', 'runner', 'Claude'); // 무관한 개인 채팅 턴이 신선해도
  assert.equal(await getRoomTurn(ws), null, '낡은 마커는 발언자 상태와 무관하게 null — 폴백이 있으면 크래시 잔재 + 무관 턴 = 30분 거짓 회의 중');
  await clearTurnStatus(ws, 'pepper'); await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('GET /api/companies/[ws]/room 은 turn을 동봉한다(실호출) — 없으면 null, 진행 중이면 active', async () => {
  const ws = 'rs-route'; await seed(ws);
  const route = await import('../app/api/companies/[ws]/room/route.js');
  const call = async () => (await route.GET(new Request(`http://127.0.0.1/api/companies/${ws}/room`), { params: Promise.resolve({ ws }) })).json();
  const idle = await call();
  assert.equal(idle.turn, null, '유휴');
  assert.equal(idle.messages?.length, 1, '방 내용은 종전대로');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  const busy = await call();
  assert.equal(busy.turn?.active, true, '진행 중이면 active — 페이지 복귀 복원의 유일한 원천');
  assert.equal(busy.turn?.slug, 'pepper');
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('getRoomTurn: 발언자|다음 순서 해석 + 발언 크루의 단계·부분 텍스트 보강(표시 전용 — 진행 판정은 마커 하나)', async () => {
  const ws = 'rs-live'; await seed(ws);
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper|carmack,davinci');
  let r = await getRoomTurn(ws);
  assert.deepEqual({ slug: r.slug, queue: r.queue, stage: r.stage, detail: r.detail, partial: r.partial },
    { slug: 'pepper', queue: ['carmack', 'davinci'], stage: null, detail: '', partial: '' }, '상태 파일 없으면 빈 값(크루 시동 전)');
  await setTurnStatus(ws, 'pepper', 'tool', 'Grep', '지금까지 말한 텍스트', 'room');
  r = await getRoomTurn(ws);
  assert.deepEqual({ stage: r.stage, detail: r.detail, partial: r.partial }, { stage: 'tool', detail: 'Grep', partial: '지금까지 말한 텍스트' }, '발언 크루의 스트리밍 상태가 방에 실린다');
  await clearTurnStatus(ws, 'pepper'); // 발언 완료 = chat()이 상태 파일을 지운다 → partial이 비고 완성 말풍선이 정본
  r = await getRoomTurn(ws);
  assert.deepEqual({ active: r.active, partial: r.partial }, { active: true, partial: '' }, '완료 후 partial 없음, 진행 판정은 마커만');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper'); // 구분자 없는 구형 마커도 해석
  r = await getRoomTurn(ws);
  assert.deepEqual({ slug: r.slug, queue: r.queue }, { slug: 'pepper', queue: [] });
  await backdate(ws, ROOM_TURN_SLUG, 5 * 60_000);
  await setTurnStatus(ws, 'pepper', 'tool', 'Grep', 'x');
  assert.equal(await getRoomTurn(ws), null, '낡은 마커는 발언 크루 상태가 신선해도 null — HIGH-2 단일 판정 유지');
  await clearTurnStatus(ws, 'pepper'); await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('출처 게이트: 발언 크루 상태는 source===room일 때만 채택 — 개인 채팅·루틴·미상 출처는 비채택(검수 MEDIUM-2)', async () => {
  const ws = 'rs-source'; await seed(ws);
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper|');
  await setTurnStatus(ws, 'pepper', 'think', '', '회의실 발언입니다', 'room');
  assert.equal((await getRoomTurn(ws)).partial, '회의실 발언입니다', '자기 발언은 채택');
  await setTurnStatus(ws, 'pepper', 'shell', 'npm test', '개인 채팅에서 쓰는 다른 문장', 'chat'); // 같은 파일을 다른 턴이 덮음
  let r = await getRoomTurn(ws);
  assert.deepEqual({ active: r.active, stage: r.stage, detail: r.detail, partial: r.partial }, { active: true, stage: null, detail: '', partial: '' }, '남의 턴 상태는 방에 뜨지 않는다(진행 판정은 그대로)');
  await setTurnStatus(ws, 'pepper', 'think', '', '출처 없는 구형 파일'); // source 미전달 = 이전 값 유지('chat')
  assert.equal((await getRoomTurn(ws)).partial, '', '이전 출처(chat) 유지 → 비채택');
  await clearTurnStatus(ws, 'pepper');
  await setTurnStatus(ws, 'pepper', 'think', '', '출처 미상'); // 새 파일에 출처 없음 = ''
  assert.equal((await getTurnStatus(ws, 'pepper')).source, '', '출처 미상은 빈 값으로 저장');
  assert.equal((await getRoomTurn(ws)).partial, '', '출처 미상은 비채택(fail-closed)');
  await clearTurnStatus(ws, 'pepper'); await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('배선: chat()이 상태 파일 갱신 전부에 턴 출처(turnSource)를 싣는다 — 하나라도 빠지면 회의실 표시가 그 단계에서 사라진다', async () => {
  const src = stripComments(await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8'));
  assert.match(src, /const turnSource = source \?\? \(from \? 'delegate' : 'chat'\);/, '출처 파생 — room 턴은 source=room 그대로');
  const calls = src.match(/setTurnStatus\(wsId, agentSlug,[^\n]*\)/g) ?? [];
  assert.ok(calls.length >= 4, `상태 갱신 호출 ${calls.length}곳(기대 ≥4: runner·boot·memory·단계)`);
  for (const c of calls) assert.match(c, /turnSource\)/, `출처 누락 호출: ${c}`);
});

test('GET /room 이 발언자·다음 순서·단계·부분 텍스트를 그대로 싣는다(실호출) — 실시간 발언 표시의 유일한 원천', async () => {
  const ws = 'rs-route-live'; await seed(ws);
  const route = await import('../app/api/companies/[ws]/room/route.js');
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper|carmack');
  await setTurnStatus(ws, 'pepper', 'think', '', '부분', 'room');
  const d = await (await route.GET(new Request(`http://127.0.0.1/api/companies/${ws}/room`), { params: Promise.resolve({ ws }) })).json();
  assert.deepEqual({ slug: d.turn?.slug, queue: d.turn?.queue, stage: d.turn?.stage, partial: d.turn?.partial },
    { slug: 'pepper', queue: ['carmack'], stage: 'think', partial: '부분' });
  await clearTurnStatus(ws, 'pepper'); await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('배선: 회의실 페이지가 발언 중인 크루의 단계·부분 텍스트·다음 순서를 그리고, 진행 중엔 2.5초 폴링한다(소스 구간 불변식)', async () => {
  const page = stripComments(await readFile(new URL('../app/c/[ws]/room/page.jsx', import.meta.url), 'utf8'));
  assert.match(page, /const \[turn, setTurn\] = useState\(null\)/);
  assert.match(page, /import \{ useLang, stageLabel \} from '\.\.\/\.\.\/\.\.\/i18n'/, '단계 라벨은 크루 채팅과 같은 사전 매핑');
  assert.match(page, /\}, live \? 2500 : 8000\);\s*\n\s*return \(\) => clearInterval\(iv\);\s*\n\s*\}, \[ws, busy, serverBusy\]\);/, '진행 중 2.5초·유휴 8초, 상태 전환에 재설정');
  assert.match(page, /const live = busy \|\| serverBusy;/, '자기 턴·서버 턴 모두 진행');
  const live = page.slice(page.indexOf('{!viewing && (busy || serverBusy) && ('), page.indexOf('<div ref={endRef} />'));
  assert.match(live, /turn\?\.slug \? \(/, '발언자를 알면 말풍선 형태');
  assert.match(live, /<Avatar name=\{nameOf\(turn\.slug\)\} size=\{26\} \/>/);
  assert.match(live, /\{turn\.stage \? t\('chat\.stageEllipsis', \{ stage: stageLabel\(t, turn\.stage, turn\.detail\) \}\) : t\('room\.speaking'\)\}/,
    "단계 미상이면 '발언 중' — 'boot'를 지어내면 CLI 러너 발언이 2분 뒤 거짓 '시동 거는 중'(검수 HIGH-1)");
  assert.doesNotMatch(live, /turn\.stage \|\| 'boot'/, "'boot' 폴백 금지");
  assert.match(live, /\{turn\.stage !== 'runner' && turn\.detail \? ` · \$\{String\(turn\.detail\)\.slice\(0, 60\)\}` : ''\}/, 'runner 단계는 detail(러너명)이 라벨에 이미 있어 중복 억제(검수 LOW-4)');
  assert.match(live, /\{turn\.partial && \(\s*\n\s*<div[^\n]*><Markdown text=\{turn\.partial\} wsId=\{ws\} \/><\/div>/, '부분 텍스트는 마크다운');
  assert.match(live, /t\('room\.next', \{ names: turn\.queue\.map\(nameOf\)\.join\(' → '\) \}\)/, '다음 순서 줄');
  assert.match(live, /\) : \(\s*\n\s*<div[^\n]*>\s*\n\s*<ArgoSpinner size=\{16\} \/> \{t\('room\.meeting'\)\}/, '발언자 미정이면 종전 스피너 줄');
  const fin = page.slice(page.indexOf('} finally {', page.indexOf('async function send(')), page.indexOf('async function endMeeting('));
  assert.match(fin, /setBusy\(false\); setTurn\(null\);/, '자기 턴 종료 시 turn만 즉시 내린다 — 마지막 partial이 완성 말풍선과 겹치지 않게');
  assert.doesNotMatch(fin, /setServerBusy\(false\)/, 'serverBusy를 여기서 끄면 다른 탭 턴 중 마치기 잠금이 최대 8초 풀린다(검수 MEDIUM-1)');
  assert.match(page, /\}, \[messages, busy, viewing, turn\?\.partial, turn\?\.stage\]\);/, '부분 텍스트가 자라는 동안 하단 추종');
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(i18n, /'room\.next': \['[^']*\{names\}[^']*', '[^']*\{names\}[^']*'\]/, 'ko/en 둘 다 {names} 치환');
});

test('DELETE /room(회의 마치기)은 턴 진행 중이면 409로 거절한다(실호출) — 서버 최종 게이트(검수 MEDIUM-1)', async () => {
  const ws = 'rs-delete'; await seed(ws);
  const route = await import('../app/api/companies/[ws]/room/route.js');
  const del = () => route.DELETE(new Request(`http://127.0.0.1/api/companies/${ws}/room`, { method: 'DELETE' }), { params: Promise.resolve({ ws }) });
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper|');
  const busy = await del();
  assert.equal(busy.status, 409, '진행 중 마치기 거절');
  assert.match((await busy.json()).error, /진행 중|still speaking/, '안내 문구');
  assert.equal((await getRoomTurn(ws))?.active, true, '거절은 마커를 건드리지 않는다');
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
  const ok = await del();
  assert.equal(ok.status, 200, '유휴면 종전대로 마친다');
});

test('배선: runRoomTurn이 마커 래퍼를 타고, 발언마다 chat() 직전에 발언자를 갱신하며, 실패를 방에 남긴다(소스 구간 불변식)', async () => {
  const src = stripComments(await readFile(new URL('../src/room.mjs', import.meta.url), 'utf8'));
  // 불변식: runRoomTurn 본문은 withRoomTurnStatus 호출 하나이고, 실제 턴(runRoomTurnInner)은 그 안에서만 불린다.
  // (#392에서 saved 표식 래퍼가 안쪽에 들어와 한 줄 형태가 아니게 됐다 — 구간으로 잠근다)
  const rt = src.slice(src.indexOf('export async function runRoomTurn('), src.indexOf('async function runRoomTurnInner('));
  assert.match(rt, /export async function runRoomTurn\(wsId, text, attachments = \[\]\) \{\s*\n\s*return withRoomTurnStatus\(wsId, async \(mark\) => \{/,
    '래퍼를 우회하면 마커가 안 생겨 복원이 죽는다');
  assert.match(rt, /return await runRoomTurnInner\(wsId, text, attachments, state, mark\);/, '실제 턴은 래퍼 안에서만, 발언자 갱신은 래퍼의 mark로');
  assert.equal((src.match(/(?<!function )runRoomTurnInner\(wsId, text, attachments/g) ?? []).length, 1, '래퍼 밖 직접 호출 금지(정의부 제외)');
  const i0 = src.indexOf('for (const [i, a] of speakers.entries())');
  const loop = src.slice(i0, src.indexOf('r = await chat(wsId, a.slug, prompt', i0));
  assert.match(src, /const markerFor = \(j\) => \(speakers\[j\] \? `\$\{speakers\[j\]\.slug\}\|\$\{speakers\.slice\(j \+ 1\)\.map\(\(s\) => s\.slug\)\.join\(','\)\}` : ''\);/,
    "마커 인코딩 '발언자|다음1,다음2' — getRoomTurn의 해석과 짝");
  assert.match(loop, /await mark\(markerFor\(i\)\)/, '발언자|다음 순서 갱신이 chat() 앞에 있어야 발언자 표시·발언 큐의 앵커가 된다');
  assert.doesNotMatch(src.slice(src.indexOf('async function runRoomTurnInner(')), /setTurnStatus\(wsId, ROOM_TURN_SLUG/, '루프의 마커 직접 쓰기 금지 — 하트비트가 덮는다');
  // 발언 종료 즉시 다음 발언자로 — 없으면 답변 적재~다음 프롬프트 조립 사이에 "옛 발언자 · 시동 거는 중"이 샌다(격리 실측 shot-1)
  const afterChat = src.slice(src.indexOf('r = await chat(wsId, a.slug, prompt', i0), src.indexOf('} catch (e) {', i0));
  assert.match(afterChat, /r = await chat\([^\n]*\);\s*\n\s*await mark\(markerFor\(i \+ 1\)\);/, 'chat() 반환 직후 마커 인계(마지막이면 빈 값)');
  // 발언 실패가 방에 남는가 — 오류는 POST 탭으로만 가므로 자리를 비운 사장에게 방은 그냥 조용하다(격리 실측: 401 뒤 흔적 0)
  const after = src.slice(src.indexOf('r = await chat(wsId, a.slug, prompt', i0));
  const catchBlk = after.slice(after.indexOf('} catch (e) {'), after.indexOf('} finally {'));
  assert.match(catchBlk, /await sys\('error', en \? `\$\{a\.name\} could not respond: \$\{msg\}` : `\$\{a\.name\} 발언 실패: \$\{msg\}`\)/, '실패 시스템 줄(ko/en)');
  assert.match(catchBlk, /maskKeyLike\(String\(e\?\.message \|\| e\)/, '오류 원문은 키 모양을 가려 적재 — 방 스레드는 동기화·회의록 대상(검수 LOW-3)');
  assert.match(catchBlk, /\n\s*throw e;/, '되던 오류 전파를 삼키면 안 된다');
  // getRoomTurn은 단일 판정 — 발언자 폴백·확장 만료 창이 되살아나면 HIGH-2가 돌아온다
  const grt = src.slice(src.indexOf('export async function getRoomTurn'), src.indexOf('export async function runRoomTurn'));
  assert.doesNotMatch(grt, /maxAgeMs|speaker|30 \* 60_000/, 'getRoomTurn에 발언자 폴백·30분 창 금지');
});

test('배선: 회의실 페이지가 turn.active를 serverBusy로 복원하고, 폴링·표시·마치기가 올바르게 묶여 있다', async () => {
  const page = stripComments(await readFile(new URL('../app/c/[ws]/room/page.jsx', import.meta.url), 'utf8'));
  assert.match(page, /const \[serverBusy, setServerBusy\] = useState\(false\)/, '서버 진행 상태는 별도 상태');
  assert.match(page, /setMessages\(d\.messages \?\? \[\]\); setServerBusy\(!!d\.turn\?\.active\); setTurn\(d\.turn \?\? null\); setError\(''\);/, '마운트 로드에서 복원');
  assert.match(page, /setTurn\(d\.turn \?\? null\); setServerBusy\(!!d\.turn\?\.active\);\s*\n\s*const srv = d\.messages \?\? \[\];\s*\n\s*setMessages\(\(cur\) => \(!busy \|\| srv\.length >= \(cur\?\.length \?\? 0\)\) \? srv : cur\);/,
    '폴링에서 복원 — serverBusy는 폴링 조건에 없다(멈추면 영구 회의 중); 자기 턴 중엔 서버 목록이 낙관 말풍선을 이미 담았을 때(길이 ≥ 로컬)만 받는다');
  assert.match(page, /\{!viewing && \(busy \|\| serverBusy\) && \(/, '표시는 둘 중 하나면 켜진다');
  assert.doesNotMatch(page, /if \(!busy && !serverBusy\)/, 'serverBusy가 폴링 조건에 들어가면 안 된다');
  // 마치기 — 서버 턴 중 마치면 도는 발언이 방·개인 스레드 어디에도 안 남는다(검수 MEDIUM-2)
  assert.match(page, /async function endMeeting\(\) \{\s*\n\s*if \(busy \|\| serverBusy\) return;/, '마치기 가드에 serverBusy');
  assert.match(page, /disabled=\{busy \|\| serverBusy\} onClick=\{endMeeting\}/, '마치기 버튼 잠금에 serverBusy');
});
