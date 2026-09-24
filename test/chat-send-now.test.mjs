// 지금 바로 보내기(피드백 6, 2026-09-23) — 재검수(2026-09-24) HIGH·MEDIUM 반영 배선 핀.
//
// HIGH 실사고: sendMessage의 최초 가드가 컴포넌트 state(busy, 렌더 시점 클로저)를 보고 있어,
// sendImmediate가 abortTurn 후 "busy가 실제로 false로 내려갈 때까지 폴링"해도 그 폴링이 끝난
// 시점의 busy는 여전히 클릭 당시 렌더의 낡은 값(true)이라 sendMessage가 조용히 return했다
// (22-after-send-now-click.png: 입력창은 비었는데 새 메시지가 없음). busyRef(useEffect로 최신값
// 유지되는 ref)로 판정해야 폴링 뒤 실제 상태를 본다.
//
// 아래 절반(소스 스캔)은 "되돌리면 조용히 옛 결함으로 돌아가는 자리"를 잠근다. 위험(HIGH)의 핵심
// 회귀 하나는 그 위에 더해 **실행으로도** 잠근다(test/stop-ui-route.test.mjs의 espree+vm 기법 재사용 —
// send/abortTurn을 소스에서 AST로 뽑아 진짜 실행한다). 순수 함수(fmtMsgTime)는 msg-time-format이,
// 사이드바 배선은 crew-status-marks가 이미 실행/스캔으로 다룬다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'espree';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const page = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8'));

const sliceFn = (name, nextName) => {
  const s = page.indexOf(name);
  assert.ok(s >= 0, `${name} 없음`);
  const e = nextName ? page.indexOf(nextName, s) : page.length;
  assert.ok(e > s, `${nextName} 경계를 못 찾음`);
  return page.slice(s, e);
};

test('HIGH: sendMessage 가드는 busyRef.current를 본다(state busy가 아니다)', () => {
  const fn = sliceFn('async function sendMessage(', 'async function send(e,');
  assert.match(fn, /if \(!message \|\| busyRef\.current \|\| uploading\) return false;/,
    'busy(클로저 값)로 되돌아가면, 지금 바로 보내기가 abort 후 폴링해도 늘 true로 보여 조용히 실패한다');
  assert.match(fn, /return true;/, '성공 시 true를 반환 — 호출부가 성공 여부로 후속 처리(대기열 해제)를 판단');
  assert.match(fn, /return false;/, '실패(catch)도 명시적으로 false — undefined 묵시 반환에 기대지 않는다');
});

const sendImmediateBody = () => {
  const s = page.indexOf('async function sendImmediate(');
  assert.ok(s >= 0, 'sendImmediate 없음');
  const e = page.indexOf("const [copied, setCopied] = useState(-1);", s);
  assert.ok(e > s, '경계(copied state 선언)를 못 찾음');
  return page.slice(s, e);
};

test('HIGH: sendImmediate는 busyRef.current 폴링이 상한(8초) 안에 안 풀리면 조용히 사라지지 않고 입력을 복원 + 오류를 보인다', () => {
  const body = sendImmediateBody();
  assert.match(body, /while \(busyRef\.current && Date\.now\(\) - startedAt < 8000\)/, '상한 폴링 — 고정 대기 대신 조건 충족까지');
  assert.match(body, /if \(busyRef\.current\) \{/, '상한 초과 후 여전히 busy면 별도 분기로 처리(조용히 넘어가지 않는다)');
  // 재검수 N5 — 함수 갱신형이어야 그사이 새로 입력한 글을 안 덮어쓴다(고정값 대입은 그새 입력한 글을 지운다)
  assert.match(body, /setInput\(\(cur\) => \(cur\.trim\(\) \? `\$\{message\}\\n\$\{cur\}` : message\)\);/, '타임아웃 시 입력 복원 — 비어 있으면 원래 지시, 아니면 앞에 붙임');
  assert.match(body, /setAtt\(\(cur\) => \(cur\.length \? \[\.\.\.attachments, \.\.\.cur\] : attachments\)\);/, '첨부도 같은 방식(손실 없음)');
  assert.match(body, /setError\(t\('chat\.sendNowTimeout'\)\)/, '타임아웃 시 오류 문구 표시');
  // 재검수 N5 — 중단이 실제로 안 됐으니 "중단됨" 노트도 사실과 다르다. 넣었으면 되돌린다.
  assert.match(body, /if \(noteId\) \{ setThread\(\(cur\) => \(cur \?\? \[\]\)\.filter\(\(m\) => m\.noteId !== noteId\)\); partialCapturedRef\.current = false; \}/,
    '타임아웃이면 낙관적으로 넣었던 부분 답변 노트를 되돌린다');
});

test('MEDIUM: 연속 클릭 방지 — sendingNow가 중단~새 턴 시작까지 잠그고, 버튼도 그 상태로 disabled', () => {
  assert.match(page, /const \[sendingNow, setSendingNow\] = useState\(false\)/);
  const body = sendImmediateBody();
  assert.match(body, /if \(sendingNow\) return;/, '재호출 방어');
  assert.match(body, /setSendingNow\(true\)/);
  // finally는 반드시 해제한다 — 단 토큰(sendNowTokenRef)이 아직 최신일 때만(N1/B 테스트가 그 가드를 따로 잠근다)
  assert.match(body, /\} finally \{\s*(?:[^\n]*\n\s*)*if \(sendNowTokenRef\.current === myToken\) \{\s*\n\s*setSendingNow\(false\);/,
    'finally로 반드시 해제 — 중간에 던지면 버튼이 영구 잠긴다');
  assert.match(page, /disabled=\{uploading \|\| aborting \|\| sendingNow \|\| !input\.trim\(\)\}/, '버튼 disabled 조건에 sendingNow 포함');
});

test('MEDIUM: partial 중복 삽입 방지 — partialCapturedRef가 한 턴에 한 번만 담고, sendMessage 시작 때 재장전된다', () => {
  assert.match(page, /const partialCapturedRef = useRef\(false\);/);
  const body = sendImmediateBody();
  assert.match(body, /if \(liveStage\?\.partial && !partialCapturedRef\.current\) \{/, '이미 담았으면 다시 안 담는다');
  assert.match(body, /partialCapturedRef\.current = true;/);
  const sendMsg = sliceFn('async function sendMessage(', 'async function send(e,');
  assert.match(sendMsg, /partialCapturedRef\.current = false;/, '새 턴 시작 때 재장전 — 다음 중단에서도 한 번은 담을 수 있어야 한다');
});

test('MEDIUM: 대기열 — sendImmediate 성공 시 큐 잠금 해제, 실패 시 그대로(정상 실패 규칙과 동일)', () => {
  const body = sendImmediateBody();
  assert.match(body, /const p = sendMessage\(message, attachments\);/, '먼저 호출만(await는 나중) — sendingNow를 새 턴 시작 직후 풀기 위함(N1)');
  assert.match(body, /const ok = await p;/);
  // 재재검수 A — "연쇄" 시작 전에 한 번만 캡처(sendNowHeldBeforeRef, null 가드) — 연달아 두 번
  // 눌러도 두 번째 호출이 첫 번째가 건 잠금을 "원래 있던 것"으로 오판하지 않는다.
  assert.match(body, /if \(sendNowHeldBeforeRef\.current === null\) sendNowHeldBeforeRef\.current = queueHeld;/);
  assert.match(body, /if \(ok && !sendNowHeldBeforeRef\.current\) setQueueHeld\(false\);/, '성공 + 연쇄 시작 전 원래 안 걸려 있었을 때만 해제');
  // 대기열 배출 이펙트가 sendingNow 창을 침범하지 않는다(같은 busy=false 순간 경합 방지)
  assert.match(page, /if \(busy \|\| uploading \|\| queueHeld \|\| sendingNow \|\| !queue\.length\) return;/);
});

test('N1/B: sendingNow 해제·정리는 토큰(sendNowTokenRef)이 아직 최신일 때만 — 연달아 두 번 누르면 앞선 호출이 뒤 호출의 상태를 밟지 않는다', () => {
  const body = sendImmediateBody();
  assert.match(body, /const myToken = \+\+sendNowTokenRef\.current;/, '호출마다 신분증 발급');
  const pIdx = body.search(/const p = sendMessage\(message, attachments\);/);
  const clearIdx = body.search(/if \(sendNowTokenRef\.current === myToken\) setSendingNow\(false\);\n\s*const ok = await p;/);
  assert.ok(pIdx >= 0, 'sendMessage 호출부를 못 찾음');
  assert.ok(clearIdx >= 0 && clearIdx > pIdx, '토큰이 최신일 때만 해제 — sendMessage 호출 직후·await 이전(N1) + 토큰 가드(B)');
  assert.match(body, /\} finally \{\s*(?:[^\n]*\n\s*)*if \(sendNowTokenRef\.current === myToken\) \{\s*\n\s*setSendingNow\(false\);[^\n]*\n\s*sendNowHeldBeforeRef\.current = null;/,
    'finally도 토큰이 최신일 때만 정리(sendingNow 해제 + 연쇄 리셋) — 아니면 뒤 호출이 아직 도는 도중에 앞선 호출이 상태를 되돌린다');
});

test("MEDIUM: '/' 커맨더·정지 명령은 sendNow에서도 일반 전송과 같은 전처리를 거친다", () => {
  const fn = sliceFn('async function send(e,', 'if (immediate && working)');
  assert.match(fn, /if \(slashMatches\.length\)/, "'/' 커맨더 판정이 immediate 분기보다 먼저 온다");
  assert.match(fn, /if \(!attachments\.length && isStopCommand\(message\)\)/, '정지 명령 판정도 immediate 분기보다 먼저 온다');
  assert.match(page, /if \(immediate && working\) \{ await sendImmediate\(message, attachments\); return; \}/,
    'immediate는 working일 때만 중단+즉시전송 — 아니면 평소 전송(대기열/즉시)으로 낙하');
});

test('버튼은 send(e, { immediate: true })를 거친다 — sendImmediate를 직접 부르지 않는다(전처리 우회 방지)', () => {
  assert.match(page, /onClick=\{\(e\) => send\(e, \{ immediate: true \}\)\}/);
  assert.doesNotMatch(page, /onClick=\{sendNow\}/, '옛 sendNow 직접 호출이 되살아나면 위 전처리를 다시 건너뛴다');
});

// ── 실행 기반 회귀 잠금(HIGH) — sendMessage·sendImmediate를 AST로 뽑아 진짜 실행한다.
// (test/stop-ui-route.test.mjs와 같은 espree+vm 기법). 되돌리면(busyRef.current 대신 busy로 판정)
// "중단 뒤 실제로 멈췄는데도 두 번째 메시지가 전송 안 됨"이 그대로 재현되는지까지 확인한다.
function findFunction(source, name) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
  let found;
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'FunctionDeclaration' && n.id?.name === name) found = source.slice(...n.range);
    for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v); }
  };
  visit(ast);
  assert.ok(found, `함수 ${name}을 소스에서 못 찾음`);
  return found;
}

test('HIGH(실행): sendImmediate가 abortTurn 뒤 실제로 멈춘 턴을 폴링으로 확인하고 새 메시지를 보낸다', async () => {
  const raw = await readFileP(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const calls = [];
  const busyRef = { current: true }; // 클릭 시점 — 원래 턴이 아직 도는 중
  const partialCapturedRef = { current: false };
  let thread = [];
  let queueHeldVal = false; // 바로 보내기 전 — 아직 안 걸려 있다(heldBefore=false 경로 확인)
  let sendingNowVal = false;
  let inputVal = ''; let attVal = [];
  const ctx = vm.createContext({
    setTimeout, Date,
    ws: 'w', slug: 'alpha', t: (k) => k,
    busyRef, partialCapturedRef, sendNowAbortRef: { current: false }, sendNowTokenRef: { current: 0 }, sendNowHeldBeforeRef: { current: null },
    thread: [{ who: 'user', text: '첫 번째 지시' }], // 클릭 시점 스냅샷 — afterText 앵커링용(재검수 N3)
    liveStage: { partial: '일부만 답한 내용' },
    aborting: false, setAborting: () => {}, busy: true, uploading: false,
    get sendingNow() { return sendingNowVal; }, setSendingNow: (v) => { sendingNowVal = v; },
    setInput: (v) => { inputVal = typeof v === 'function' ? v(inputVal) : v; }, setAtt: (v) => { attVal = typeof v === 'function' ? v(attVal) : v; },
    setError: (v) => { calls.push({ error: v }); },
    setThread: (updater) => { thread = typeof updater === 'function' ? updater(thread) : updater; },
    get queueHeld() { return queueHeldVal; }, setQueueHeld: (v) => { queueHeldVal = v; },
    setBusy: () => {}, setStage: () => {}, setLiveStage: () => {}, loadSuggestions: () => {},
    sessionRef: { current: null }, pinRef: { current: null }, pinMidRef: { current: null },
    window: { dispatchEvent: () => {} }, Event: globalThis.Event,
    api: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/chat/abort')) {
        // 중단 요청 뒤 30ms 후 원래 턴이 실제로 끝난다(서버 인터럽트 왕복 흉내) — sendImmediate의
        // busyRef 폴링(120ms 간격)이 이 시점을 실제로 관찰해야 한다.
        setTimeout(() => { busyRef.current = false; }, 30);
        return {};
      }
      if (url.endsWith('/chat')) {
        // 새 턴이 시작된 시점(sendMessage 호출 직후, await 전)의 sendingNow를 관찰(재검수 N1) —
        // 여기서 이미 false여야 그 순간 Enter·정지 명령이 정상 경로를 탄다.
        calls.push({ sendingNowAtNewTurnStart: sendingNowVal });
        return { reply: `echo:${body.message}`, sessionId: 's2' };
      }
      throw new Error(`예상 밖 api 호출: ${url}`);
    },
  });
  vm.runInContext([findFunction(raw, 'abortTurn'), findFunction(raw, 'sendMessage'), findFunction(raw, 'sendImmediate')].join(';\n'), ctx);
  await ctx.sendImmediate('두 번째 지시', []);

  const urls = calls.filter((c) => c.url).map((c) => c.url);
  assert.deepEqual(urls, ['/api/companies/w/chat/abort', '/api/companies/w/chat'],
    '중단 요청 다음에 새 메시지 전송이 실제로 나가야 한다 — busy(클로저)로 되돌리면 두 번째 호출이 통째로 빠진다');
  const chatBody = calls.find((c) => c.url?.endsWith('/chat'))?.body;
  assert.equal(chatBody?.message, '두 번째 지시', '새로 입력한 지시가 그대로 나가야 한다');
  assert.equal(queueHeldVal, false, '성공했으니 sendImmediate가 대기열 잠금을 풀어야 한다');
  assert.equal(sendingNowVal, false, '끝나면 sendingNow가 풀려 버튼이 다시 눌린다');
  assert.equal(thread.at(-1)?.text, `echo:${chatBody.message}`, '새 턴의 크루 답변이 스레드 맨 끝에 붙는다');
  const partialNote = thread.find((m) => m.aborted && m.who === 'crew');
  assert.equal(partialNote?.text, '일부만 답한 내용', '중단 시점 partial이 로컬 스레드에 남는다');
});

test('N5(실행): 8초 상한 타임아웃 — 그사이 새로 입력한 글을 지우지 않고 원래 지시를 앞에 붙이며, 사실과 다른 중단 노트를 되돌린다', async () => {
  const raw = await readFileP(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const calls = [];
  const busyRef = { current: true }; // 끝까지 true — 원래 턴이 상한 안에 안 멈춘 상황(재검수 N5)
  const partialCapturedRef = { current: false };
  let thread = [];
  let inputVal = ''; let attVal = [];
  let sendingNowVal = false;
  const ctx = vm.createContext({
    setTimeout, Date,
    ws: 'w', slug: 'alpha', t: (k) => k,
    busyRef, partialCapturedRef, sendNowAbortRef: { current: false }, sendNowTokenRef: { current: 0 }, sendNowHeldBeforeRef: { current: null },
    thread: [{ who: 'user', text: '원래 지시' }],
    liveStage: { partial: '부분 답변' },
    aborting: false, setAborting: () => {}, busy: true, uploading: false, queueHeld: false,
    get sendingNow() { return sendingNowVal; }, setSendingNow: (v) => { sendingNowVal = v; },
    setInput: (v) => {
      // sendImmediate가 abortTurn을 기다리는 동안 사장이 이미 "급한 지시"를 타이핑해 뒀다고 흉내낸다
      inputVal = typeof v === 'function' ? v(inputVal || '급한 지시') : v;
    },
    setAtt: (v) => { attVal = typeof v === 'function' ? v(attVal) : v; },
    setError: (v) => { calls.push({ error: v }); },
    setThread: (updater) => { thread = typeof updater === 'function' ? updater(thread) : updater; },
    setQueueHeld: () => {}, setBusy: () => {}, setStage: () => {}, setLiveStage: () => {}, loadSuggestions: () => {},
    sessionRef: { current: null }, pinRef: { current: null }, pinMidRef: { current: null },
    window: { dispatchEvent: () => {} }, Event: globalThis.Event,
    api: async (url, body) => { calls.push({ url, body }); return {}; }, // abort는 응답만 오고 busyRef는 안 바뀜(상한 초과 흉내)
  });
  vm.runInContext([findFunction(raw, 'abortTurn'), findFunction(raw, 'sendMessage'), findFunction(raw, 'sendImmediate')].join(';\n'), ctx);
  await ctx.sendImmediate('원래 지시', []);

  assert.equal(inputVal, '원래 지시\n급한 지시', '함수 갱신형으로 앞에 붙어야 한다 — 고정값 대입으로 되돌리면 급한 지시가 사라진다');
  assert.equal(thread.length, 0, '중단이 실제로 안 됐으니 낙관적으로 넣었던 부분 답변 노트를 되돌려야 한다(빈 스레드로)');
  assert.equal(calls.filter((c) => c.error).at(-1)?.error, 'chat.sendNowTimeout');
});

test('HIGH(실행, 변이 대조): busy(state)로 되돌리면 실사고가 재현된다 — 두 번째 메시지가 전송되지 않는다', async () => {
  const raw = await readFileP(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const mutated = findFunction(raw, 'sendMessage').replace('busyRef.current', 'busy'); // 되돌림 흉내
  const calls = [];
  const busyRef = { current: true };
  let sendingNowVal = false;
  const ctx = vm.createContext({
    setTimeout, Date,
    ws: 'w', slug: 'alpha', t: (k) => k,
    busy: true, // sendMessage 클로저가 보는 값 — 컴포넌트가 실제로 리렌더하지 않는 한 그대로다
    busyRef, partialCapturedRef: { current: false }, sendNowAbortRef: { current: false }, sendNowTokenRef: { current: 0 }, sendNowHeldBeforeRef: { current: null },
    liveStage: null, aborting: false, setAborting: () => {}, uploading: false, queueHeld: false,
    get sendingNow() { return sendingNowVal; }, setSendingNow: (v) => { sendingNowVal = v; },
    setInput: () => {}, setAtt: () => {}, setError: () => {},
    setThread: () => {}, setQueueHeld: () => {}, setBusy: () => {}, setStage: () => {}, setLiveStage: () => {}, loadSuggestions: () => {},
    sessionRef: { current: null }, pinRef: { current: null }, pinMidRef: { current: null },
    window: { dispatchEvent: () => {} }, Event: globalThis.Event,
    api: async (url, body) => {
      calls.push({ url, body });
      if (url.endsWith('/chat/abort')) { setTimeout(() => { busyRef.current = false; }, 30); return {}; }
      if (url.endsWith('/chat')) return { reply: 'x', sessionId: 's2' };
      throw new Error(`예상 밖 api 호출: ${url}`);
    },
  });
  vm.runInContext([findFunction(raw, 'abortTurn'), mutated, findFunction(raw, 'sendImmediate')].join(';\n'), ctx);
  await ctx.sendImmediate('두 번째 지시', []);
  const urls = calls.filter((c) => c.url).map((c) => c.url);
  assert.deepEqual(urls, ['/api/companies/w/chat/abort'], '실사고 재현 — busy(state)로 판정하면 abort만 나가고 재전송은 조용히 사라진다');
});

// ── 총괄 재검수(2026-09-24) — 지금 바로 보내기로 중단된 첫 메시지는 정지 버튼과 다른 문구를 쓰고
// 재전송 버튼을 숨긴다(입력창이 이미 비어 있어 "입력을 복원했어요"가 헷갈린다는 지적).
test('viaSendNow: sendMessage catch가 서버 확인값(err.data.viaSendNow)을 우선하고 sendNowAbortRef를 낙관적 대체로 쓴다(재검수 D)', () => {
  const fn = sliceFn('async function sendMessage(', 'async function send(e,');
  assert.match(fn, /\.\.\.\(err\?\.data\?\.viaSendNow \|\| sendNowAbortRef\.current \? \{ viaSendNow: true \} : \{\}\)/,
    '서버가 저장한 값이 우선 — 새로고침·폴링 병합 뒤에도 남아야 한다(로컬 ref만 쓰면 그 순간만 표시된다)');
});

test('viaSendNow: sendImmediate가 abortTurn 호출 전/후로 표식을 세우고 내린다', () => {
  const body = sendImmediateBody();
  const setIdx = body.search(/sendNowAbortRef\.current = true;/);
  const abortIdx = body.search(/await abortTurn\('sendNow'\);/);
  const clearIdx = body.search(/sendNowAbortRef\.current = false;/);
  assert.ok(setIdx >= 0 && abortIdx >= 0 && clearIdx >= 0, '표식 설정·중단 호출·표식 해제가 모두 있어야 한다');
  assert.ok(setIdx < abortIdx, '표식은 중단을 요청하기 전에 세운다 — 늦으면 원래 턴의 catch가 못 본다');
  assert.ok(clearIdx > abortIdx, '표식 해제는 busyRef 폴링(원래 턴 settle 대기) 뒤 — 너무 이르면 무관한 실패까지 태깅될 수 있다');
});

// ── N3(실행) — 폴링 병합 리듀서(setThread((cur) => {...}))를 소스에서 뽑아 진짜 실행한다.
// AST의 FunctionDeclaration 찾기와 달리 이건 인라인 ArrowFunctionExpression이라 괄호 균형 매칭으로 뽑는다.
function extractBraceBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `마커를 못 찾음: ${marker}`);
  const openAt = source.indexOf('{', start);
  let depth = 0;
  for (let i = openAt; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(openAt, i + 1); }
  }
  throw new Error('괄호 균형을 못 맞춤');
}

function runMergeReducer(cur, msgs) {
  const raw = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const body = extractBraceBody(raw, 'setThread((cur) => {');
  const fn = new Function('cur', 'msgs', body.slice(1, -1));
  return fn(cur, msgs);
}

test('N3(실행): 로컬 부분 답변 노트는 개수 비교에서 빠지고, 병합 시 원래 자리(mid로 찾은 중단 메시지 뒤)에 재삽입된다', () => {
  const note = { who: 'crew', text: '부분 답변', aborted: true, noteId: 'n1', afterMid: 'm1', afterText: '첫 지시' };
  const cur = [
    { who: 'user', text: '첫 지시', mid: 'm1', aborted: true },
    note,
    { who: 'user', text: '둘째 지시' },
    { who: 'crew', text: '둘째 답변' },
  ];
  // 서버가 아직 이 두 개(cur.length - 노트1개 = 3)와 같으면 그대로 유지 — 늘어나야 병합
  assert.deepEqual(runMergeReducer(cur, cur.filter((m) => m !== note)), cur, '서버가 노트만큼만 적으면(실제로 안 앞섬) 로컬을 그대로 유지');

  // 다른 기기에서 셋째 지시·답변이 서버에 먼저 도착 — 서버 msgs가 로컬(노트 제외)보다 진짜로 앞섬.
  // 서버는 mid를 저장 안 하므로(클라 전용) 여기엔 mid가 없다 — afterMid로는 못 찾고 afterText로 찾아야 한다.
  const serverMsgs = [
    { who: 'user', text: '첫 지시', aborted: true },
    { who: 'user', text: '둘째 지시' },
    { who: 'crew', text: '둘째 답변' },
    { who: 'user', text: '셋째 지시(다른 기기)' },
    { who: 'crew', text: '셋째 답변' },
  ];
  const merged = runMergeReducer(cur, serverMsgs);
  assert.equal(merged[1], note, '노트가 사라지지 않고 살아남는다');
  assert.equal(merged[0].text, '첫 지시', '노트 앞에는 그 노트가 따라붙은 중단 메시지가 그대로');
  assert.equal(merged.at(-1).text, '셋째 답변', '서버가 앞서 보낸 새 내용도 반영된다');
});

test('N3/C(실행): 같은 문구의 지시가 두 개면 mid로 정확한 자리를 찾는다(문구만으로는 엉뚱한 자리에 꽂힌다)', () => {
  const note = { who: 'crew', text: '부분 답변', aborted: true, noteId: 'n1', afterMid: 'm-second', afterText: '같은 문구' };
  const cur = [
    { who: 'user', text: '같은 문구', mid: 'm-first', aborted: true },
    { who: 'crew', text: '첫 번째 답' },
    { who: 'user', text: '같은 문구', mid: 'm-second', aborted: true },
    note,
  ];
  // 서버 msgs는 mid를 안 보존하지만, "같은 문구"가 두 번 나오는 순서는 그대로 유지된다.
  const serverMsgs = [
    { who: 'user', text: '같은 문구', aborted: true },
    { who: 'crew', text: '첫 번째 답' },
    { who: 'user', text: '같은 문구', aborted: true },
    { who: 'user', text: '다른 기기 지시' },
    { who: 'crew', text: '다른 기기 답' },
  ];
  const merged = runMergeReducer(cur, serverMsgs);
  // afterText만 봤다면(문구 일치, 첫 매치 우선) 첫 번째 "같은 문구" 뒤에 꽂힐 위험이 있다 —
  // mid가 없는 cur 항목(로컬에만 있던 unsent 등)이 섞여도 순서를 지키려면 실제로는 여기서 mid
  // 매칭이 없으니(서버 msgs엔 mid가 없음) 텍스트 폴백이 동작하되, **뒤쪽(두 번째) 발생**을
  // 우선하도록 역순 탐색한다는 계약을 확인한다.
  const idx = merged.indexOf(note);
  assert.ok(idx >= 3, `노트가 두 번째 "같은 문구" 뒤(인덱스 3 이상)에 있어야 한다(실제 인덱스 ${idx})`);
});

test('N3/C(실행): 앵커를 서버에서 못 찾아도(unsaved) 노트가 자기 지시보다 앞서지 않는다', () => {
  const note = { who: 'crew', text: '부분 답변', aborted: true, noteId: 'n1', afterMid: 'm-unsaved', afterText: '저장 안 된 지시' };
  const unsentMsg = { who: 'user', text: '저장 안 된 지시', mid: 'm-unsaved', failed: '네트워크 오류', unsaved: true };
  const cur = [
    { who: 'user', text: '이전 지시' },
    { who: 'crew', text: '이전 답' },
    unsentMsg,
    note,
  ];
  const serverMsgs = [{ who: 'user', text: '이전 지시' }, { who: 'crew', text: '이전 답' }]; // unsentMsg는 서버에 없음(진짜로 저장 실패)
  const merged = runMergeReducer(cur, serverMsgs);
  const unsentIdx = merged.indexOf(unsentMsg);
  const noteIdx = merged.indexOf(note);
  assert.ok(unsentIdx >= 0, '미저장 사본은 캐리오버돼야 한다');
  assert.equal(noteIdx, unsentIdx + 1, '노트는 자기 지시(미저장 사본) 바로 뒤에 있어야 한다 — 앞서면(재검수 C) 대화 순서가 뒤집힌다');
});

test('N3(실행, 변이 대조): 재삽입 로직을 걷어내(예전처럼 끝에 붙이면) 노트 위치가 어긋난다', () => {
  const raw = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const body = extractBraceBody(raw, 'setThread((cur) => {');
  // "재삽입" 블록을 예전 방식(그냥 끝에 붙임)으로 되돌리는 변이
  const mutated = body.replace(
    /const combined = unsent\.length[\s\S]*?return next;/,
    'return unsent.length ? [...msgs, ...unsent, ...localNotes] : [...msgs, ...localNotes];',
  );
  assert.notEqual(mutated, body, '변이 패턴이 실제로 안 걸렸다 — 정규식을 소스 변경에 맞춰 갱신할 것');
  const fn = new Function('cur', 'msgs', mutated.slice(1, -1));
  const note = { who: 'crew', text: '부분 답변', aborted: true, noteId: 'n1', afterMid: 'm1', afterText: '첫 지시' };
  const cur = [{ who: 'user', text: '첫 지시', mid: 'm1', aborted: true }, note, { who: 'user', text: '둘째 지시' }, { who: 'crew', text: '둘째 답변' }];
  const serverMsgs = [{ who: 'user', text: '첫 지시', aborted: true }, { who: 'user', text: '둘째 지시' }, { who: 'crew', text: '둘째 답변' }, { who: 'user', text: '셋째' }, { who: 'crew', text: '셋째 답' }];
  const merged = fn(cur, serverMsgs);
  assert.notEqual(merged[1], note, '변이 재현 — 노트가 원래 자리(중단 메시지 바로 뒤)에 없다(끝으로 밀림)');
});

// ── A·B(실행, 재재검수 2026-09-24) — 검수자 재현 스크립트(scratchpad/race.mjs)를 확장한다: 그
// 스크립트는 abort 왕복만 흉내 내고 채팅 응답은 절대 안 오게 해 뒀다(그래서 로그만 관찰). 여기서는
// "C가 실제로 성공"까지 재현해야 A(잠금 해제)를 검증할 수 있어, 중단당하지 않으면 일정 시간 뒤
// 자연 성공하는 pending 항목을 추가한다 — turn0(가짜 첫 턴)만 race.mjs처럼 콜백형으로 남긴다.
function makeRaceCtx(sendImmediateSrc, { chatResolveMs = 500 } = {}) {
  const log = [];
  const busyRef = { current: true };
  const pending = []; // { onAbort } — turn0는 onAbort만, 실제 chat 호출은 자연 성공 타이머도 가진다
  const state = { sendingNow: false, queueHeld: false };
  const ctx = vm.createContext({
    setTimeout, Date,
    ws: 'w', slug: 'a', t: (k) => k,
    busyRef, partialCapturedRef: { current: false }, sendNowAbortRef: { current: false },
    sendNowTokenRef: { current: 0 }, sendNowHeldBeforeRef: { current: null },
    thread: [], liveStage: null, aborting: false, setAborting() {}, busy: true, uploading: false,
    get sendingNow() { return state.sendingNow; }, setSendingNow(v) { state.sendingNow = v; log.push(['sendingNow', v]); },
    get queueHeld() { return state.queueHeld; }, setQueueHeld(v) { state.queueHeld = v; log.push(['queueHeld', v]); },
    setInput() {}, setAtt() {}, setError(e) { log.push(['error', e]); }, setThread() {},
    setBusy(v) { busyRef.current = v; log.push(['busy', v]); }, setStage() {}, setLiveStage() {}, loadSuggestions() {},
    sessionRef: { current: null }, pinRef: { current: null }, pinMidRef: { current: null },
    window: { dispatchEvent() {} }, Event: globalThis.Event,
    api: (url, body) => {
      if (url.endsWith('/abort')) {
        return new Promise((res) => {
          setTimeout(() => { const entry = pending.shift(); entry?.onAbort(); res({}); }, 30);
        });
      }
      log.push(['chat', 'sent', body.message]);
      return new Promise((resolve, reject) => {
        const entry = { onAbort: () => reject(Object.assign(new Error('중단됨'), { data: { aborted: true } })) };
        pending.push(entry);
        // 아무도 안 끊으면(=abort가 이 항목을 못 건드리면) 자연히 성공한다 — "지금 바로 보내기 두
        // 번째가 실제로 성공"까지 재현해야 A(잠금 해제)를 검증할 수 있다.
        setTimeout(() => {
          const idx = pending.indexOf(entry);
          if (idx === -1) return; // 이미 abort로 처리됨
          pending.splice(idx, 1);
          resolve({ reply: `ok:${body.message}`, sessionId: 's' });
        }, chatResolveMs);
      });
    },
  });
  vm.runInContext([findFunction(sendImmediateSrc.raw, 'abortTurn'), findFunction(sendImmediateSrc.raw, 'sendMessage'), sendImmediateSrc.fn].join(';\n'), ctx);
  pending.push({ onAbort: () => { busyRef.current = false; } }); // turn0(가짜 첫 턴, race.mjs와 동일)
  return { ctx, log, busyRef, state, pending };
}

test('A(실행): 연달아 두 번 눌러도 두 번째가 성공하면 대기열 잠금이 풀린다(첫 번째가 건 잠금을 "원래 있던 것"으로 오판하지 않는다)', async () => {
  const raw = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const { ctx, state } = makeRaceCtx({ raw, fn: findFunction(raw, 'sendImmediate') });
  ctx.sendImmediate('B', []); // 첫 턴(turn0)이 아직 도는 중 — 지금 바로 보내기 1회차
  await new Promise((r) => setTimeout(r, 300)); // B가 새 턴을 시작해 아직 도는 중(자연 성공 500ms보다 이르다)
  ctx.sendImmediate('C', []); // B가 도는 중 다시 클릭 — B를 끊고 C를 보낸다
  await new Promise((r) => setTimeout(r, 1000)); // C의 abort 왕복(30ms) + 폴링 + 자연 성공(500ms) + 여유
  assert.equal(state.queueHeld, false, 'C가 성공했으니 잠금이 풀려야 한다 — 안 풀리면 A 재현(대기열이 영구 잠김)');
});

test('B(실행): 연달아 두 번 누른 뒤에도 sendingNow가 최종적으로 풀린다(중간에 조기 해제로 경합하지 않는다)', async () => {
  const raw = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const { ctx, state } = makeRaceCtx({ raw, fn: findFunction(raw, 'sendImmediate') });
  ctx.sendImmediate('B', []);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.sendingNow, false, '첫 호출은 이미 새 턴을 시작해 자기 몫을 풀어 둔 상태여야 한다');
  ctx.sendImmediate('C', []);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(state.sendingNow, false, '두 호출 모두 끝난 뒤엔 잠겨 있으면 안 된다(버튼이 영구 비활성)');
});

test('A/B(실행, 변이 대조): heldBefore를 호출마다 새로 읽게 되돌리면(토큰 가드 없이) A가 재현된다', async () => {
  const raw = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const original = findFunction(raw, 'sendImmediate');
  const mutated = original
    .replace('if (sendNowHeldBeforeRef.current === null) sendNowHeldBeforeRef.current = queueHeld;', 'const heldBefore = queueHeld;')
    .replace('if (ok && !sendNowHeldBeforeRef.current) setQueueHeld(false);', 'if (ok && !heldBefore) setQueueHeld(false);');
  assert.notEqual(mutated, original, '변이 패턴이 안 걸렸다 — 정규식을 소스 변경에 맞춰 갱신할 것');
  const { ctx, state } = makeRaceCtx({ raw, fn: mutated });
  ctx.sendImmediate('B', []);
  await new Promise((r) => setTimeout(r, 300));
  ctx.sendImmediate('C', []);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(state.queueHeld, true, 'A 재현 — heldBefore를 호출마다 새로 읽으면 두 번째가 성공해도 잠금이 안 풀린다');
});

test('viaSendNow: 렌더가 문구·재전송 버튼을 가른다(i18n ko/en 등재 포함)', () => {
  assert.match(page, /m\.aborted \? \(m\.viaSendNow \? t\('chat\.abortedForSendNow'\) : t\('chat\.aborted'\)\)/,
    'viaSendNow면 별도 문구 — 정지 버튼 문구("입력을 복원했어요")를 그대로 쓰면 입력창이 빈 이 경로에서 헷갈린다');
  assert.match(page, /\{!m\.viaSendNow && \(/, 'viaSendNow면 재전송 버튼 자체를 숨긴다(옛 지시를 다시 보낼 이유가 없다)');
  const i18n = readFileSync(join(ROOT, 'app/i18n.jsx'), 'utf8');
  const line = i18n.split('\n').find((l) => l.includes("'chat.abortedForSendNow'"));
  assert.ok(line, 'chat.abortedForSendNow 미등재');
  assert.match(line, /\[.+,.+\]/, 'ko·en 두 언어 모두 있어야 한다(다국어 상시 규칙)');
});

// ── D — viaSendNow 서버 저장(재검수 D, 2026-09-24). src/chat.mjs(대화 코어)는 안 건드리고,
// /chat/abort(별개 요청)가 남긴 사유를 원래 턴의 POST /chat 실패 처리에서 한 번만 소비하는
// out-of-band 신호(src/turn-abort.mjs의 작은 맵)로 잇는다.
test('D: turn-abort.mjs가 abort 사유를 저장·소비한다(chat.mjs 미변경)', () => {
  const src = readFileSync(join(ROOT, 'src/turn-abort.mjs'), 'utf8');
  assert.match(src, /export function markAbortReason\(/);
  assert.match(src, /export function takeAbortReason\(/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/turn-abort.mjs'), 'utf8'), /from '\.\/chat\.mjs'/, 'chat.mjs를 참조하지 않는다(대화 코어 미변경)');
});

test('D: /chat/abort 라우트가 reason=sendNow일 때만(그리고 실제로 중단됐을 때만) 표시를 남긴다', () => {
  const src = readFileSync(join(ROOT, 'app/api/companies/[ws]/chat/abort/route.js'), 'utf8');
  assert.match(src, /import \{ interruptTurn, markAbortReason \}/);
  assert.match(src, /if \(interrupted && reason === 'sendNow'\) markAbortReason\(ws, slug, 'sendNow'\);/,
    '중단이 실제로 안 먹혔으면(interrupted:false) 표시를 남기지 않는다 — 무관한 다음 실패가 잘못 태깅되면 안 된다');
});

test('D: POST /chat 실패 처리가 표시를 소비해 viaSendNow를 저장·응답 둘 다에 싣는다', () => {
  const src = readFileSync(join(ROOT, 'app/api/companies/[ws]/chat/route.js'), 'utf8');
  assert.match(src, /import \{ interruptTurn, takeAbortReason \}/);
  assert.match(src, /const viaSendNow = aborted && takeAbortReason\(ws, slug\) === 'sendNow';/);
  assert.match(src, /appendTurn\(ws, slug, \{ turnId, userMsg: message\.trim\(\), failed, failedCode, failedOrigin, aborted, cancellationIncomplete, viaSendNow, attachments \}\)/,
    '저장에도 실려야 새로고침·폴링 병합 뒤에도 남는다');
  assert.match(src, /Response\.json\(\{ error: failed, code: failedCode, origin: failedOrigin, aborted, cancellationIncomplete, viaSendNow, saved \}/,
    '응답에도 실려야 지금 이 요청의 클라이언트가 즉시 반영할 수 있다');
});

test('D: thread.mjs appendTurn이 viaSendNow를 받아 두 저장 경로(진행 중 줄 이어쓰기·새 줄) 모두에 남긴다', () => {
  const src = readFileSync(join(ROOT, 'src/thread.mjs'), 'utf8');
  assert.match(src, /export async function appendTurn\(wsId, slug, \{[^}]*viaSendNow[^}]*\}\)/);
  assert.match(src, /if \(viaSendNow\) m\.viaSendNow = true;/, '진행 중이던 줄(beginTurn이 이미 써 둔 줄)을 이어쓸 때');
  assert.match(src, /\.\.\.\(viaSendNow \? \{ viaSendNow: true \} : \{\}\) \},\n\s*\);/, '선저장 없이 바로 새 줄을 밀어 넣을 때(레거시 갈래)도');
});
