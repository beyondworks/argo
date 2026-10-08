// 네이티브 엔진 턴 안 예산 — 한 턴의 도구 반복은 매 벤더 호출마다 전사 전체를 다시 보낸다. 요약 압축(compact.mjs)은 턴 시작에만 돌아서
// 큰 Read를 반복하는 턴은 호출마다 수만 자씩 불어 모델 창을 넘었다(제보 2026-10-08 Grok "50만·60만 컨텍스트 넘음" — origin/main 재현: 큰 파일 Read
// 1회당 요청 약 6.2만 자 증가, 22번째 호출에서 grok-4.6 창 50만 토큰 초과 → 400 → 저장 꼬리가 tool_result라 다음 턴 재개 때 그 턴 진행분이 통째로 사라져
// 같은 작업을 처음부터 반복하다 같은 지점에서 또 실패).
// 규칙: 매 호출 직전 (system + 도구 + 전사) 추정이 창의 75%를 넘으면 오래된 tool_result 내용을 앞부분 + 자리표시로 줄여 창의 50%까지 내린다
// (한 번 줄일 때 넉넉히 줄여 매 단계 다시 줄이지 않는다 — 줄일 때마다 프롬프트 캐시 앞부분이 바뀐다). 최근 도구 결과 3개는 그대로, tool_use/tool_result 짝(id)·
// 끼워 넣기 글·지시·크루 글·요약 블록은 건드리지 않는다. 벤더가 길이 초과로 거절하면(벤더별 문구) 창을 거절 지점 기준으로 낮추고 더 세게 줄여 같은 단계를 한 번만 다시 보낸다.
// 다시 쓸 수 있는 것(도구를 다시 실행하면 같은 내용)만 줄인다 — Anthropic 문맥 편집(clear_tool_uses)·Claude Code 마이크로 압축과 같은 방향.
import { estimateTokens, COMPACT_AT } from './compact.mjs';
import { isContextOverflowText } from '../runners/error-class.mjs';

export const TURN_BUDGET_AT = COMPACT_AT; // 0.75 — 턴 시작 압축과 같은 기준선
export const TURN_SQUEEZE_TO = 0.5;
export const SQUEEZE_KEEP_RECENT = 3;     // 그대로 두는 최근 도구 결과 메시지 수(평소)
export const SQUEEZE_HEAD_CHARS = 1000;   // 줄인 결과에 남기는 앞부분(글자)
export const HARD_KEEP_RECENT = 1;        // 벤더 길이 초과 뒤 재시도
export const HARD_HEAD_CHARS = 200;

// 자리표시 끝 줄 — 원래 길이를 싣는다(다시 줄일 때 원래 길이를 잃지 않게 이 줄에서 다시 읽는다)
const NOTE = {
  ko: (n) => `…(대화가 길어져 이 도구 결과를 줄였다 — 원래 ${n}자. 필요하면 도구를 다시 실행해 읽어라)`,
  en: (n) => `…(This tool result was shortened because the conversation grew long — originally ${n} chars. Run the tool again if you need it.)`,
};
const NOTE_RE = /…\((?:대화가 길어져 이 도구 결과를 줄였다 — 원래 (\d+)자\. 필요하면 도구를 다시 실행해 읽어라|This tool result was shortened because the conversation grew long — originally (\d+) chars\. Run the tool again if you need it\.)\)$/;
const IMAGE_NOTE = { ko: '[이미지 생략]', en: '[image omitted]' };

const isResultMsg = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result');

/** tool_result 블록 하나를 줄인다(순수) — 같은 블록이면(이미 그만큼 짧다) 그대로 돌려준다. id·is_error는 유지, 내용은 글 하나로. */
export function squeezeResultBlock(b, head = SQUEEZE_HEAD_CHARS, lang = 'ko') {
  const l = lang === 'en' ? 'en' : 'ko';
  const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
  const hasImage = inner.some((x) => x?.type === 'image');
  let text = inner.map((x) => (x?.type === 'text' ? String(x.text ?? '') : x?.type === 'image' ? IMAGE_NOTE[l] : '')).filter(Boolean).join('\n');
  let orig = text.length;
  const prev = NOTE_RE.exec(text);
  if (prev) { orig = Number(prev[1] ?? prev[2]); text = text.slice(0, prev.index).replace(/\n$/, ''); } // 이미 줄인 결과 — 원래 길이를 이어받는다
  const note = NOTE[l](orig);
  if (!hasImage && (prev ? text.length <= head : text.length <= head + note.length)) return b; // 줄여도 짧아지지 않는다
  const kept = text.slice(0, head);
  return { ...b, content: kept ? `${kept}\n${note}` : note };
}

/** 오래된 도구 결과부터 줄여 추정 토큰이 target 이하가 되면 멈춘다(순수·비파괴). fixed = system + 도구 정의 추정.
    keepRecent = 그대로 두는 최근 도구 결과 메시지 수. 반환 { messages, squeezed(줄인 블록 수), tokens(줄인 뒤 추정) }. */
export function squeezeToolResults(messages, { fixed = 0, target, keepRecent = SQUEEZE_KEEP_RECENT, head = SQUEEZE_HEAD_CHARS, lang = 'ko' } = {}) {
  let tokens = fixed + estimateTokens(messages);
  if (!(tokens > target)) return { messages, squeezed: 0, tokens };
  const idx = messages.map((m, i) => (isResultMsg(m) ? i : -1)).filter((i) => i >= 0);
  const cand = keepRecent > 0 ? idx.slice(0, -keepRecent) : idx;
  const out = messages.slice();
  let squeezed = 0;
  for (const i of cand) {
    if (tokens <= target) break;
    const m = out[i]; let n = 0;
    const content = m.content.map((b) => { if (b?.type !== 'tool_result') return b; const s = squeezeResultBlock(b, head, lang); if (s !== b) n += 1; return s; });
    if (!n) continue;
    const next = { ...m, content };
    tokens += estimateTokens(next) - estimateTokens(m);
    out[i] = next; squeezed += n;
  }
  return squeezed ? { messages: out, squeezed, tokens } : { messages, squeezed: 0, tokens };
}

/** 이 오류가 벤더의 컨텍스트 길이 초과 거절인가 — 문구로 판정(벤더마다 상태 코드가 다르다: 400·413, Responses 스트림 실패는 502). 한도·과금 문구는 제외. */
export const isContextOverflowError = (e) => !e?.aborted && isContextOverflowText(String(e?.message ?? e ?? ''));

// 거절 원문의 (요청 토큰, 한도) — 벤더별 문구. 못 읽으면 null(호출부가 '거절 지점 = 한도 위'로만 쓴다).
const NUMS = [
  [/maximum (?:prompt|context) length is ([\d,]+)[\s\S]*?(?:contains|requested(?: about)?) ([\d,]+)/i, 2, 1], // xAI·OpenRouter·OpenAI 호환
  [/prompt is too long: ([\d,]+) tokens? > ([\d,]+)/i, 1, 2],                                                 // Anthropic
  [/input token count \(([\d,]+)\) exceeds the maximum number of tokens allowed \(([\d,]+)\)/i, 1, 2],        // Gemini
  [/token limit: ([\d,]+) \(requested: ([\d,]+)\)/i, 2, 1],                                                  // Kimi(Moonshot)
];
export function overflowNumbers(msg) {
  const s = String(msg ?? '');
  for (const [re, ni, li] of NUMS) {
    const m = re.exec(s); if (!m) continue;
    const requested = Number(m[ni].replace(/,/g, '')); const limit = Number(m[li].replace(/,/g, ''));
    if (requested > 0 && limit > 0 && requested > limit) return { requested, limit };
  }
  return null;
}

/** 길이 초과 거절 뒤 이 턴의 창(추정 토큰 단위, 순수) — 거절된 요청의 추정(sentTokens)이 한도 위였다. 원문에 숫자가 있으면 벤더 셈과 우리 추정의 비로 한도를 환산하고,
    없으면 거절 지점을 창으로 본다. 우리 추정이 벤더보다 적게 세는 모델(토크나이저 차이)·카탈로그 창보다 실제 한도가 작은 엔드포인트도 다음 단계부터 같은 창으로 맞춘다. */
export function windowAfterOverflow(window, sentTokens, msg) {
  const nums = overflowNumbers(msg);
  const w = nums ? Math.floor(sentTokens * (nums.limit / nums.requested)) : sentTokens;
  return Math.max(1, Math.min(window, w));
}

/** 길이 초과로 멈춘 턴의 진행분을 다음 턴이 잇게 하는 꼬리(순수) — 저장 전사가 tool_result로 끝나면 재개 정리(session.mjs sanitizeTranscript)가 그 턴을 통째로
    걷어낸다. 끝난 도구 결과 뒤에 크루 글 한 줄을 붙여 역할 교대를 맞추고, 다음 지시에서 끝난 단계를 반복하지 않게 사실을 적는다. */
export function overflowStopNote(lang = 'ko') {
  return lang === 'en'
    ? "[Stopped — the request exceeded the model's context limit at this step (old tool results were shortened and resent, but it still did not fit). The tool results above are completed work. If asked to continue, do not repeat completed steps; resume with what remains, reading only what you need.]"
    : '[작업 중단 — 요청이 모델의 컨텍스트 한도를 넘어 이 단계에서 멈췄다(오래된 도구 결과를 줄여 다시 보냈지만 넘쳤다). 위 도구 결과까지는 끝난 작업이다. 이어서 하라는 지시가 오면 끝난 단계를 반복하지 말고 남은 일부터, 필요한 것만 읽어라.]';
}

/** 실패 원문(errors[0]) — 사실(한도 초과·한 번 줄여 다시 보냄·진행분 저장 여부) + 벤더 원문. 화면은 실패 코드(chat.fail.context_exceeded)로 할 일을 따로 보이고
    이 글은 활동 기록·툴팁에 남는다. error-class가 머리 낱말('컨텍스트 한도 초과'·'Context limit exceeded')로 context_exceeded를 문다. */
export function overflowErrorText(raw, lang = 'ko', { saved = false } = {}) {
  const r = String(raw ?? '').slice(0, 400);
  return lang === 'en'
    ? `Context limit exceeded — resent once after shortening old tool results, but it still exceeded the model limit${saved ? ' (progress so far is saved — send "continue" to resume)' : ''}: ${r}`
    : `컨텍스트 한도 초과 — 오래된 도구 결과를 줄여 한 번 다시 보냈지만 모델 한도를 넘었다${saved ? '(지금까지 한 단계는 저장됨 — "이어서 해 줘"로 이어 간다)' : ''}: ${r}`;
}
