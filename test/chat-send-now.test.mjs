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
  assert.match(body, /setInput\(message\); setAtt\(attachments\);/, '타임아웃 시 입력 복원');
  assert.match(body, /setError\(t\('chat\.sendNowTimeout'\)\)/, '타임아웃 시 오류 문구 표시');
});

test('MEDIUM: 연속 클릭 방지 — sendingNow가 중단~새 턴 시작까지 잠그고, 버튼도 그 상태로 disabled', () => {
  assert.match(page, /const \[sendingNow, setSendingNow\] = useState\(false\)/);
  const body = sendImmediateBody();
  assert.match(body, /if \(sendingNow\) return;/, '재호출 방어');
  assert.match(body, /setSendingNow\(true\)/);
  assert.match(body, /\} finally \{\s*setSendingNow\(false\);\s*\}/, 'finally로 반드시 해제 — 중간에 던지면 버튼이 영구 잠긴다');
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
  assert.match(body, /const ok = await sendMessage\(message, attachments\);/);
  assert.match(body, /if \(ok\) setQueueHeld\(false\);/, '성공했을 때만 해제 — 실패면 sendMessage의 catch가 이미 다시 잠갔다');
  // 대기열 배출 이펙트가 sendingNow 창을 침범하지 않는다(같은 busy=false 순간 경합 방지)
  assert.match(page, /if \(busy \|\| uploading \|\| queueHeld \|\| sendingNow \|\| !queue\.length\) return;/);
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
  let queueHeldVal = true; // abortTurn이 즉시 True로 건다(실코드와 동일 계약)
  let sendingNowVal = false;
  let inputVal = ''; let attVal = [];
  const ctx = vm.createContext({
    setTimeout, Date,
    ws: 'w', slug: 'alpha', t: (k) => k,
    busyRef, partialCapturedRef,
    liveStage: { partial: '일부만 답한 내용' },
    aborting: false, setAborting: () => {}, busy: true, uploading: false,
    get sendingNow() { return sendingNowVal; }, setSendingNow: (v) => { sendingNowVal = v; },
    setInput: (v) => { inputVal = v; }, setAtt: (v) => { attVal = v; },
    setError: (v) => { calls.push({ error: v }); },
    setThread: (updater) => { thread = typeof updater === 'function' ? updater(thread) : updater; },
    setQueueHeld: (v) => { queueHeldVal = v; },
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
      if (url.endsWith('/chat')) return { reply: `echo:${body.message}`, sessionId: 's2' };
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
    busyRef, partialCapturedRef: { current: false },
    liveStage: null, aborting: false, setAborting: () => {}, uploading: false,
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
