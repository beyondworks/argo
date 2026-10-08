// 네이티브 엔진 턴 안 예산 — 한 턴의 도구 반복은 매 벤더 호출마다 전사 전체를 다시 보낸다. 요약 압축(compact.mjs)은 턴 시작에만 돌아서
// 큰 Read를 반복하는 턴은 호출마다 수만 자씩 불어 모델 창을 넘었다(제보 2026-10-08 Grok "50만·60만 컨텍스트 넘음" — origin/main 재현: 큰 파일 Read
// 1회당 요청 약 6.2만 자 증가, 22번째 호출에서 grok-4.6 창 50만 토큰 초과 → 400 → 저장 꼬리가 tool_result라 다음 턴 재개 때 그 턴 진행분이 통째로 사라져
// 같은 작업을 처음부터 반복하다 같은 지점에서 또 실패).
// 규칙: 매 호출 직전 (system + 도구 + 전사) 추정이 창의 75%를 넘으면 오래된 tool_result 내용을 앞부분 + 자리표시로 줄여 창의 50%까지 내린다
// (한 번 줄일 때 넉넉히 줄여 매 단계 다시 줄이지 않는다 — 줄일 때마다 프롬프트 캐시 앞부분이 바뀐다). 최근 도구 결과 3개는 그대로, tool_use/tool_result 짝(id)·
// 끼워 넣기 글·지시·크루 글·요약 블록은 건드리지 않는다. 벤더가 길이 초과로 거절하면(벤더별 문구) 창을 거절 지점 기준으로 낮추고 더 세게 줄여 같은 단계를 한 번만 다시 보낸다.
// 줄이는 순서: 다시 실행해도 부작용이 없는 읽기 도구(RERUNNABLE_TOOLS) 결과를 먼저 줄이고 자리표시에 '다시 실행해 읽어라'를 단다. 그래도 넘치면 나머지
// (위임·쓰기·발송·셸·브라우저 조작·MCP) 결과를 줄이되 자리표시에 '이미 실행됐다 — 같은 호출을 다시 하지 마라'를 단다(1차 검수 MEDIUM: delegate를 다시 부르면
// 동료 턴·파일 쓰기·발송·비용이 두 번 생긴다). Anthropic 문맥 편집(clear_tool_uses)·Claude Code 마이크로 압축과 같은 방향.
import { estimateTokens, COMPACT_AT, tailStart } from './compact.mjs';
import { sanitizeTranscript } from './session.mjs';
import { isContextOverflowText } from '../runners/error-class.mjs';

export const TURN_BUDGET_AT = COMPACT_AT; // 0.75 — 턴 시작 압축과 같은 기준선
export const TURN_SQUEEZE_TO = 0.5;
export const SQUEEZE_KEEP_RECENT = 3;     // 그대로 두는 최근 도구 결과 메시지 수(평소)
export const SQUEEZE_HEAD_CHARS = 1000;   // 줄인 결과에 남기는 앞부분(글자)
export const HARD_KEEP_RECENT = 1;        // 벤더 길이 초과 뒤 재시도
export const HARD_HEAD_CHARS = 200;

// 자리표시 끝 줄 — 원래 길이를 싣는다(다시 줄일 때 원래 길이를 잃지 않게 이 줄에서 다시 읽는다). rerun = 다시 실행해도 되는 도구인가.
const NOTE = {
  ko: (n, rerun) => `…(대화가 길어져 이 도구 결과를 줄였다 — 원래 ${n}자. ${rerun ? '필요하면 도구를 다시 실행해 읽어라' : '이 도구는 이미 실행됐다 — 같은 호출을 다시 하지 마라'})`,
  en: (n, rerun) => `…(This tool result was shortened because the conversation grew long — originally ${n} chars. ${rerun ? 'Run the tool again if you need it.' : 'The tool already ran — do not call it again.'})`,
};
const NOTE_RE = /…\((?:대화가 길어져 이 도구 결과를 줄였다 — 원래 (\d+)자\. (?:필요하면 도구를 다시 실행해 읽어라|이 도구는 이미 실행됐다 — 같은 호출을 다시 하지 마라)|This tool result was shortened because the conversation grew long — originally (\d+) chars\. (?:Run the tool again if you need it\.|The tool already ran — do not call it again\.))\)$/;
const IMAGE_NOTE = { ko: '[이미지 생략]', en: '[image omitted]' };

const isResultMsg = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');

/** 다시 실행해도 부작용이 없는 읽기 도구 — 결과를 줄이면 '다시 실행해 읽어라'를 단다. 나머지(Write·Edit·Bash·브라우저 조작·browser_eval·computer_* 조작·
    크루 도구 mcp__crew__*(delegate 등)·외부 MCP)는 다시 부르면 쓰기·발송·위임이 또 일어날 수 있어 '다시 하지 마라'를 달고, 읽기 결과를 다 줄인 뒤에만 줄인다. */
export const RERUNNABLE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'browser_status', 'browser_snapshot', 'browser_screenshot', 'computer_screenshot']);

/** tool_result 블록 하나를 줄인다(순수) — 같은 블록이면(이미 그만큼 짧다) 그대로 돌려준다. id·is_error는 유지, 내용은 글 하나로.
    rerun = 다시 실행해도 되는 도구의 결과인가(자리표시 문구가 갈린다 — RERUNNABLE_TOOLS). */
export function squeezeResultBlock(b, head = SQUEEZE_HEAD_CHARS, lang = 'ko', { rerun = true } = {}) {
  const l = lang === 'en' ? 'en' : 'ko';
  const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
  const hasImage = inner.some((x) => x?.type === 'image');
  let text = inner.map((x) => (x?.type === 'text' ? String(x.text ?? '') : x?.type === 'image' ? IMAGE_NOTE[l] : '')).filter(Boolean).join('\n');
  let orig = text.length;
  const prev = NOTE_RE.exec(text);
  if (prev) { orig = Number(prev[1] ?? prev[2]); text = text.slice(0, prev.index).replace(/\n$/, ''); } // 이미 줄인 결과 — 원래 길이를 이어받는다
  const note = NOTE[l](orig, rerun);
  if (!hasImage && (prev ? text.length <= head : text.length <= head + note.length)) return b; // 줄여도 짧아지지 않는다
  const kept = text.slice(0, head);
  return { ...b, content: kept ? `${kept}\n${note}` : note };
}

/** 오래된 도구 결과부터 줄여 추정 토큰이 target 이하가 되면 멈춘다(순수·비파괴). fixed = system + 도구 정의 추정.
    keepRecent = 그대로 두는 최근 도구 결과 메시지 수. recentFrom = 그 '최근'을 세기 시작하는 메시지 위치(이보다 앞의 결과는 최근이어도 줄일 수 있다 —
    재시도는 이번 턴의 지시 뒤만 센다: 앞 턴이 남긴 큰 결과를 보호하면 다음 턴마다 첫 호출에서 넘쳤다, 1차 검수 HIGH).
    순서: 읽기 도구(RERUNNABLE_TOOLS) 결과를 오래된 것부터 먼저, 그래도 넘치면 나머지 도구 결과를 오래된 것부터. 이름을 모르는 결과(tool_use를 못 찾음)는 나머지로 본다.
    반환 { messages, squeezed(줄인 블록 수), tokens(줄인 뒤 추정) }. */
export function squeezeToolResults(messages, { fixed = 0, target, keepRecent = SQUEEZE_KEEP_RECENT, head = SQUEEZE_HEAD_CHARS, lang = 'ko', recentFrom = 0 } = {}) {
  let tokens = fixed + estimateTokens(messages);
  if (!(tokens > target)) return { messages, squeezed: 0, tokens };
  const idx = messages.map((m, i) => (isResultMsg(m) ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(keepRecent > 0 ? idx.filter((i) => i >= recentFrom).slice(-keepRecent) : []);
  const cand = idx.filter((i) => !recent.has(i));
  const nameOf = new Map();
  for (const m of messages) if (m?.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use') nameOf.set(b.id, b.name);
  const rerunnable = (b) => RERUNNABLE_TOOLS.has(nameOf.get(b.tool_use_id));
  const out = messages.slice();
  let squeezed = 0;
  for (const pass of [true, false]) { // true = 읽기 도구 결과, false = 나머지
    for (const i of cand) {
      if (tokens <= target) break;
      const m = out[i]; let n = 0;
      const content = m.content.map((b) => {
        if (b?.type !== 'tool_result' || rerunnable(b) !== pass) return b;
        const s = squeezeResultBlock(b, head, lang, { rerun: pass }); if (s !== b) n += 1; return s;
      });
      if (!n) continue;
      const next = { ...m, content };
      tokens += estimateTokens(next) - estimateTokens(m);
      out[i] = next; squeezed += n;
    }
  }
  return squeezed ? { messages: out, squeezed, tokens } : { messages, squeezed: 0, tokens };
}

/** 이번 턴 지시(마지막 지시)의 위치 — 재시도 줄이기가 '최근'을 세기 시작하는 자리. 지시가 없으면 0. */
export const turnStartIndex = (messages) => tailStart(messages, 1);

/** 이 오류가 벤더의 컨텍스트 길이 초과 거절인가 — 문구로 판정(벤더마다 상태 코드가 다르다: 400·413, Responses 스트림 실패는 502). 한도·과금 문구는 제외. */
export const isContextOverflowError = (e) => !e?.aborted && isContextOverflowText(String(e?.message ?? e ?? ''));

// 거절 원문의 (요청 토큰, 한도) — 벤더별 문구. 못 읽으면 null(호출부가 '거절 지점 = 한도 위'로만 쓴다).
// Anthropic의 'input length and `max_tokens` exceed context limit: 입력 + 출력 > 한도'는 입력에 쓸 수 있는 몫(한도 − 출력)을 한도로 본다.
const NUMS = [
  [/maximum (?:prompt|context) length is ([\d,]+)[\s\S]*?(?:contains|requested(?: about)?) ([\d,]+)/i, (m) => [m[2], m[1]]], // xAI·OpenRouter·OpenAI 호환
  [/prompt is too long: ([\d,]+) tokens? > ([\d,]+)/i, (m) => [m[1], m[2]]],                                                 // Anthropic
  [/exceeds? context limit: ([\d,]+) \+ ([\d,]+) > ([\d,]+)/i, (m) => [m[1], String(num(m[3]) - num(m[2]))]],                 // Anthropic(입력 + 출력)
  [/input token count \(([\d,]+)\) exceeds the maximum number of tokens allowed \(([\d,]+)\)/i, (m) => [m[1], m[2]]],        // Gemini
  [/token limit: ([\d,]+) \(requested: ([\d,]+)\)/i, (m) => [m[2], m[1]]],                                                  // Kimi(Moonshot)
];
const num = (x) => Number(String(x).replace(/,/g, ''));
export function overflowNumbers(msg) {
  const s = String(msg ?? '');
  for (const [re, pick] of NUMS) {
    const m = re.exec(s); if (!m) continue;
    const [r, l] = pick(m); const requested = num(r); const limit = num(l);
    if (requested > 0 && limit > 0 && requested > limit) return { requested, limit };
  }
  return null;
}

/** 거절 원문의 숫자로 환산한 한도(추정 토큰 단위, 순수) — 거절된 요청의 추정(sentTokens) × 벤더 한도/벤더 셈. 숫자를 못 읽으면 null.
    이 턴에 확실히 아는 한도는 이 값과 벤더가 받아 준 요청 크기뿐이다 — 숫자 없는 문구의 거절 지점은 한도의 위쪽 끝일 뿐이다(3차 검수 HIGH). */
export function limitFromOverflow(sentTokens, msg) {
  const nums = overflowNumbers(msg);
  return nums ? Math.floor(sentTokens * (nums.limit / nums.requested)) : null;
}

/** 길이 초과 거절 뒤 이 턴의 창(추정 토큰 단위, 순수) — 거절된 요청의 추정(sentTokens)이 한도 위였다. 원문에 숫자가 있으면 벤더 셈과 우리 추정의 비로 한도를 환산하고,
    없으면 거절 지점을 창으로 본다(줄이기 목표용 — 다음 단계부터 같은 창으로 맞춘다). 저장할 전사가 들어가는지는 이 값이 아니라 확실한 값으로만 잰다(native-query 실패 갈래). */
export function windowAfterOverflow(window, sentTokens, msg) {
  const w = limitFromOverflow(sentTokens, msg) ?? sentTokens;
  return Math.max(1, Math.min(window, w));
}

/** 길이 초과로 멈춘 턴의 진행분을 다음 턴이 잇게 하는 꼬리(순수) — 저장 전사가 tool_result로 끝나면 재개 정리(session.mjs sanitizeTranscript)가 그 턴을 통째로
    걷어낸다. 끝난 도구 결과 뒤에 크루 글 한 줄을 붙여 역할 교대를 맞추고, 다음 지시에서 끝난 단계를 반복하지 않게 사실을 적는다.
    저장 전에 이 턴의 결과까지 한도 안으로 줄이므로(native-query 실패 갈래 — 줄인 결과는 자리표시가 스스로 밝힌다) 다시 읽을 때는 나눠 읽으라고 같이 적는다.
    줄여도 한도 안에 들지 않는 전사(큰 도구 입력·지시·크루 글)에는 붙이지 않는다 — 붙이면 다음 턴마다 첫 호출에서 넘친다(실패 갈래가 판정). */
export function overflowStopNote(lang = 'ko') {
  return lang === 'en'
    ? "[Stopped — the request exceeded the model's context limit at this step. The tool results above are completed work. If asked to continue, do not repeat completed steps; resume with what remains. If you need a shortened read result again, re-read only the part you need, one at a time.]"
    : '[작업 중단 — 요청이 모델의 컨텍스트 한도를 넘어 이 단계에서 멈췄다. 위 도구 결과까지는 끝난 작업이다. 이어서 하라는 지시가 오면 끝난 단계를 반복하지 말고 남은 일부터 하라. 줄인 읽기 결과가 다시 필요하면 필요한 부분만 하나씩 다시 읽어라.]';
}

const STOP_NOTE_HEADS = ['[작업 중단 — 요청이 모델의 컨텍스트 한도를 넘어', "[Stopped — the request exceeded the model's context limit"];
/** 길이 초과로 멈춘 턴의 꼬리(overflowStopNote)인가 — 크루 글 한 블록이 그 머리로 시작한다(ko·en). */
export const isOverflowStopNote = (m) => m?.role === 'assistant' && Array.isArray(m.content) && m.content.length === 1 && m.content[0]?.type === 'text'
  && STOP_NOTE_HEADS.some((h) => String(m.content[0].text ?? '').startsWith(h));

/** 안전망(순수, 3차 검수 HIGH) — 이번 턴 지시 바로 앞에 중단 기록으로 끝난 턴이 있으면 연달은 그런 턴을 **전부** 걷어낸 전사, 없으면 null.
    중단 기록을 빼면 그 턴 꼬리가 tool_result(또는 답 없는 지시)가 되어 재개 정리(session.mjs sanitizeTranscript)가 main처럼 그 턴을 통째로 걷어낸다 — 같은 함수를
    그대로 쓰고, 걷어낸 뒤 꼬리가 또 중단 기록이면(멈춘 턴이 연달아 저장됨) 그것도 걷어낸다(4차 검수 MEDIUM: 하나만 걷어내면 앞의 멈춘 턴이 남아 한도가 준 뒤
    대화가 영구히 막혔다 — main은 재개 정리가 둘 다 걷어낸다). 끝난 턴이 사이에 끼면 거기서 멈춘다. native-query가 1단계 길이 초과에서 줄여 다시 보내기로도
    못 풀 때 한 번만 쓴다: 어떤 추정이 틀려도 중단 기록으로 이은 전사가 대화를 영구히 막지 않게. */
export function dropStoppedTurn(messages) {
  const p = turnStartIndex(messages);
  if (p < 1 || !isOverflowStopNote(messages[p - 1])) return null;
  let head = messages.slice(0, p);
  while (head.length && isOverflowStopNote(head.at(-1))) head = sanitizeTranscript(head.slice(0, -1));
  return [...head, ...messages.slice(p)];
}

/** 실패 원문(errors[0]) — 사실(한도 초과·줄여 다시 보냈는가·진행분을 다음 턴이 잇는가) + 벤더 원문. 화면은 실패 코드(chat.fail.context_exceeded)로 할 일을 따로 보이고
    이 글은 활동 기록·툴팁에 남는다. error-class가 머리 낱말('컨텍스트 한도 초과'·'Context limit exceeded')로 context_exceeded를 문다.
    resent = 이 단계를 줄여 한 번 다시 보냈는가(줄일 도구 결과가 없으면 다시 보내지 않는다 — 그때 '다시 보냈지만'이라고 쓰면 사실이 아니다).
    cut = 안전망으로 앞 턴의 멈춘 진행분(중단 기록으로 끝난 턴)을 빼고 다시 보냈는가.
    resumable = 진행분을 저장했고 다음 턴이 그 전사를 이어받는가(이어 온 세션 + 줄인 전사가 한도 안) — 이때만 '이어서 해 줘'를 쓴다(2차 검수 LOW: 새 대화의 첫 턴은
    스레드에 세션 id가 남지 않아 이어받지 못한다). dropped = 줄여도 한도 안에 들지 않아 진행분을 잇지 않는다(다음 턴 재개 정리가 이 턴을 걷어낸다). 둘 다 아니면 덧붙이지 않는다. */
export function overflowErrorText(raw, lang = 'ko', { resent = false, cut = false, resumable = false, dropped = false } = {}) {
  const r = String(raw ?? '').slice(0, 400);
  if (lang === 'en') {
    const what = cut ? "resent once without the previous turn's stopped progress, but it still exceeded the model limit"
      : resent ? 'resent once after shortening old tool results, but it still exceeded the model limit' : 'the request exceeded the model limit; there were no more tool results to shorten, so it was not resent';
    const after = resumable ? ' (completed steps are saved — send "continue" to resume)' : dropped ? ' (even with tool results shortened it does not fit the limit, so this progress is not carried into the next turn)' : '';
    return `Context limit exceeded — ${what}${after}: ${r}`;
  }
  const what = cut ? '앞 턴의 멈춘 진행분을 빼고 한 번 다시 보냈지만 모델 한도를 넘었다'
    : resent ? '오래된 도구 결과를 줄여 한 번 다시 보냈지만 모델 한도를 넘었다' : '요청이 모델 한도를 넘었다. 더 줄일 도구 결과가 없어 다시 보내지 않았다';
  const after = resumable ? '(지금까지 한 단계는 저장됨 — "이어서 해 줘"로 이어 간다)' : dropped ? '(도구 결과를 줄여도 한도 안에 들어가지 않아 이번 진행분은 다음 턴에 싣지 않는다)' : '';
  return `컨텍스트 한도 초과 — ${what}${after}: ${r}`;
}
