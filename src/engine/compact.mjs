// 네이티브 엔진 토큰 예산 + 요약 압축 — 매 턴 전사 전체를 다시 보내므로 대화가 길어지면 모델 컨텍스트 창을 넘는다.
// 종전 상한은 글자 수(SESSION_MAX_CHARS 40만)뿐이라 창이 작은 모델에서는 그 전에 벤더가 거절했고, 넘친 앞부분은 요약 없이 버려졌다.
// 규칙: (system + 도구 + 전사) 추정 토큰이 창의 75%를 넘으면 최근 20턴은 그대로 두고 그 앞부분을 같은 러너 원샷으로 요약해
// 남은 첫 지시 앞에 요약 블록으로 붙인다(역할 교대를 깨지 않게 새 메시지를 만들지 않는다). 요약이 실패하면 앞부분을 잘라낸다.
// 비용 상한: 한 번 요약한 세션은 앞부분에 새 턴이 10개 이상 쌓여야 다시 요약한다. 창의 95%를 넘으면 예외지만 그때도 ① 직전 압축 뒤 앞부분에
// 새 지시가 1개 이상 밀려났고 ② 압축하면 실제로 95% 아래로 내려갈 때만이다(최근 20턴만으로 넘치면 앞부분 요약은 효과가 없어 턴마다 돈만 쓴다 — 분리 검수 HIGH).
// 토큰은 블록 단위로 보수 추정한다: 글·도구 입출력은 utf-8 바이트/3, 이미지·문서(base64) 블록은 고정값 — base64를 바이트로 세면 스크린샷 1장이
// ≈60,000토큰이 되어 최근 20턴에 2장만 있어도 긴급 경로가 턴마다 돌았다(분리 검수 HIGH — 벤더는 이미지를 줄여 받아 장당 수천 토큰 이하).

export const DEFAULT_CONTEXT_TOKENS = 128_000; // 카탈로그에 창 값이 없는 모델 — 보수적으로
// 전사 예산 — 압축 기준 창은 min(모델 창, 이 값)이다. 모델 창(카탈로그 ctx, 1M 등)만 쓰면 75%(750,000토큰)가 세션 글자 상한
// (session.mjs SESSION_MAX_CHARS 40만 자 — 넘치면 앞부분을 요약 없이 버린다)보다 늦게 와 요약이 영영 일어나지 않고, 매 턴 다시 보내는 입력도
// 수십만 토큰으로 커진다. 이 값의 75%(96,000토큰 ≈ 영문 29만 자·한글 9.6만 자)는 글자 상한보다 항상 먼저 온다. 1M 창을 실제로 쓰려면 글자 상한과 함께 올려야 한다.
export const TRANSCRIPT_BUDGET_TOKENS = 128_000;
export const COMPACT_AT = 0.75;
export const COMPACT_EMERGENCY_AT = 0.95;
export const COMPACT_KEEP_TURNS = 20;
export const COMPACT_MIN_NEW_TURNS = 10;
export const COMPACT_SUMMARY_TOKENS = 4000;
const SUMMARY_TEXT_CAP = 16_000; // 지시를 넘겨 길게 와도 전사에 싣는 상한(글자)
const RENDER_BLOCK_CAP = 1500;   // 요약 입력에서 도구 결과·긴 글 한 블록의 상한(글자)

// 이미지 1장의 토큰 — Anthropic 비전 문서: 28×28px 조각 하나가 1토큰(⌈가로/28⌉×⌈세로/28⌉), 표준 등급은 1장 최대 1,568토큰으로 줄여 받는다
// (https://platform.claude.com/docs/en/build-with-claude/vision 확인 2026-10-05). 같은 문서의 고해상도 등급(Claude 4.7 이후)은 최대 4,784토큰이라 그 모델에서는
// 장당 ≈3,200토큰 덜 센다 — 압축 기준 75%가 남기는 25% 여유와 전사 글자 상한(오래된 스크린샷은 1장만 남김, session.mjs)이 흡수한다.
// 문서(PDF) 블록은 엔진이 지금 만들지 않는다(grep 0) — 같은 고정값으로 센다.
export const IMAGE_TOKENS = 1600;
const isBinaryBlock = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && (v.type === 'image' || v.type === 'document' || (v.source?.type === 'base64' && typeof v.source.data === 'string'));
/** 추정 토큰(순수) — 글은 utf-8 바이트/3, 이미지·문서 블록은 base64를 빼고 1개당 IMAGE_TOKENS. 도구 결과 안에 든 블록도 같다. */
export function estimateTokens(x) {
  if (typeof x === 'string') return Math.ceil(Buffer.byteLength(x, 'utf8') / 3);
  let bins = 0;
  const json = JSON.stringify(x ?? '', (_k, v) => { if (isBinaryBlock(v)) { bins += 1; return undefined; } return v; }) ?? '';
  return Math.ceil(Buffer.byteLength(json, 'utf8') / 3) + bins * IMAGE_TOKENS;
}

// 지시 = 글이 있고 tool_result가 없는 user(session.mjs isPromptMsg와 같은 술어)
const isPrompt = (m) => m?.role === 'user' && (Array.isArray(m.content) ? m.content.some((b) => b?.type !== 'tool_result') && !m.content.some((b) => b?.type === 'tool_result') : true);

/** 최근 keepTurns개 지시가 시작되는 자리(순수). 지시가 그보다 적으면 0(앞부분 없음). */
export function tailStart(messages, keepTurns = COMPACT_KEEP_TURNS) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (isPrompt(messages[i]) && ++seen === keepTurns) return i;
  return 0;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…(${s.length - n}자 생략)` : s);
/** 요약 입력용 전사 글(순수) — 도구 호출·결과는 짧게. 첫 메시지(앞 요약을 품을 수 있다)는 넉넉히. 상한을 넘으면 첫 메시지 뒤 오래된 것부터 뺀다. */
export function renderForSummary(messages, maxTokens, lang = 'ko') {
  const en = lang === 'en';
  const one = (m, i) => {
    const who = m.role === 'user' ? (en ? 'Captain/tool' : '사장·도구') : (en ? 'Crew' : '크루');
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
    const parts = blocks.map((b) => {
      if (b?.type === 'text') return clip(String(b.text ?? ''), i === 0 ? SUMMARY_TEXT_CAP + 4000 : 4000);
      if (b?.type === 'tool_use') return `[${en ? 'tool call' : '도구 호출'} ${b.name} ${clip(JSON.stringify(b.input ?? {}), 300)}]`;
      if (b?.type === 'tool_result') { const c = typeof b.content === 'string' ? b.content : (b.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n'); return `[${en ? 'tool result' : '도구 결과'}${b.is_error ? (en ? ' (error)' : '(오류)') : ''}] ${clip(String(c), RENDER_BLOCK_CAP)}`; }
      if (b?.type === 'image') return en ? '[image]' : '[이미지]';
      return '';
    }).filter(Boolean);
    return `${who}: ${parts.join('\n')}`;
  };
  const lines = messages.map(one);
  let total = lines.reduce((a, l) => a + estimateTokens(l), 0);
  while (lines.length > 2 && total > maxTokens) { total -= estimateTokens(lines[1]); lines.splice(1, 1); }
  return lines.join('\n\n');
}

export function summaryPrompt(transcript, lang = 'ko') {
  return lang === 'en'
    ? `Below is the earlier part of a long conversation between a crew member (AI agent) and the captain. Summarize it so the crew can keep working without the original: decisions made, work in progress or promised, file paths, names, numbers and preferences the captain stated. If it begins with an earlier summary, fold that in. Write at most ${COMPACT_SUMMARY_TOKENS} tokens and output only the summary.\n\n<conversation>\n${transcript}\n</conversation>`
    : `아래는 크루(AI 에이전트)와 사장의 긴 대화 중 앞부분이다. 원문 없이도 크루가 이어서 일할 수 있게 요약하라: 정한 것, 진행 중이거나 약속한 일, 나온 파일 경로·이름·숫자, 사장이 밝힌 선호. 앞에 이전 요약이 있으면 그 내용도 합쳐라. 최대 ${COMPACT_SUMMARY_TOKENS}토큰으로, 요약문만 출력하라.\n\n<conversation>\n${transcript}\n</conversation>`;
}

const SUMMARY_HEAD = { en: '[Summary of the earlier conversation — it grew long, so the earlier part was summarized. Continue from this summary and the conversation that follows]', ko: '[앞 대화 요약 — 대화가 길어져 앞부분을 요약했다. 이 요약과 이어지는 대화를 바탕으로 이어서 일하라]' };
const summaryBlock = (text, lang) => ({ type: 'text', text: lang === 'en' ? `${SUMMARY_HEAD.en}\n${text}\n[End of summary]` : `${SUMMARY_HEAD.ko}\n${text}\n[요약 끝]` });
/** 요약 블록을 품은 지시(직전 압축이 남긴 머리)인가(순수) — 벤더로 나가는 블록에 표지 필드를 달 수 없어 머리 글로 알아본다(언어 무관). */
const carriesSummary = (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && (String(b.text).startsWith(SUMMARY_HEAD.ko) || String(b.text).startsWith(SUMMARY_HEAD.en)));

/** 필요하면 전사를 압축한다(sess.messages 교체). 반환 { compacted, trimmed, preTokens }.
    summarize(prompt) → 요약 글(같은 러너 원샷). 실패·빈 답이면 앞부분을 예산까지 잘라낸다. 중단(aborted)은 그대로 던진다. */
export async function compactTranscript(sess, { system = '', tools = [], window: modelWindow = DEFAULT_CONTEXT_TOKENS, summarize, lang = 'ko' }) {
  const window = Math.min(modelWindow, TRANSCRIPT_BUDGET_TOKENS); // 위 TRANSCRIPT_BUDGET_TOKENS 주석
  const fixed = estimateTokens(system) + estimateTokens(tools);
  const size = (msgs) => fixed + estimateTokens(msgs);
  const preTokens = size(sess.messages);
  if (preTokens <= window * COMPACT_AT) return { compacted: false, trimmed: false, preTokens };
  const cut = tailStart(sess.messages);
  if (cut <= 0) return { compacted: false, trimmed: false, preTokens }; // 최근 20턴뿐 — 지금의 글자 수 절단(saveNativeSession)만 적용
  const head = sess.messages.slice(0, cut); const tail = sess.messages.slice(cut);
  // 직전 압축 뒤 앞부분으로 새로 밀려난 지시 수 — 요약을 품은 머리(직전 압축의 결과)는 세지 않는다
  const newTurns = head.filter(isPrompt).length - (carriesSummary(head[0]) ? 1 : 0);
  if (sess.compacted && newTurns < COMPACT_MIN_NEW_TURNS) {
    // 긴급(95%) 예외에도 최소 간격 — 새 지시 1개 이상 + 압축 뒤 크기(최근 20턴 + 요약 몫)가 95% 아래일 때만. 아니면 요약해도 다시 넘쳐 턴마다 반복된다.
    const helps = size(tail) + COMPACT_SUMMARY_TOKENS <= window * COMPACT_EMERGENCY_AT;
    if (!(preTokens > window * COMPACT_EMERGENCY_AT && newTurns >= 1 && helps)) return { compacted: false, trimmed: false, preTokens };
  }
  let text = '';
  try {
    text = String(await summarize(summaryPrompt(renderForSummary(head, Math.floor(window * 0.6), lang), lang)) ?? '').trim();
  } catch (e) {
    if (e?.aborted) throw e;
    console.warn(`[argo] 네이티브 전사 요약 실패 — 앞부분을 잘라내고 이어 간다: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  if (text) {
    const first = tail[0];
    const content = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
    sess.messages = [{ ...first, content: [summaryBlock(text.slice(0, SUMMARY_TEXT_CAP), lang), ...content] }, ...tail.slice(1)];
    sess.compacted = true;
    return { compacted: true, trimmed: false, preTokens };
  }
  // 잘라내기 — 앞부분을 오래된 것부터 빼되 머리는 지시로 맞춘다(짝 없는 tool_result 방지). 최근 20턴은 남긴다.
  const kept = head.slice();
  while (kept.length && size([...kept, ...tail]) > window * COMPACT_AT) kept.shift();
  while (kept.length && !isPrompt(kept[0])) kept.shift();
  sess.messages = [...kept, ...tail];
  sess.compacted = true; // 잘라낸 세션도 같은 간격 규칙 — 요약이 계속 실패하는 벤더에 턴마다 다시 묻지 않게
  return { compacted: false, trimmed: true, preTokens };
}
