// 네이티브 엔진 토큰 예산 + 요약 압축 — 매 턴 전사 전체를 다시 보내므로 대화가 길어지면 모델 컨텍스트 창을 넘는다.
// 종전 상한은 글자 수(SESSION_MAX_CHARS 40만)뿐이라 창이 작은 모델에서는 그 전에 벤더가 거절했고, 넘친 앞부분은 요약 없이 버려졌다.
// 규칙: (system + 도구 + 전사) 추정 토큰이 창의 75%를 넘으면 최근 20턴은 그대로 두고 그 앞부분을 같은 러너 원샷으로 요약해
// 남은 첫 지시 앞에 요약 블록으로 붙인다(역할 교대를 깨지 않게 새 메시지를 만들지 않는다). 요약이 실패하면 앞부분을 잘라낸다.
// 비용 상한: 한 번 요약한 세션은 앞부분에 새 턴이 10개 이상 쌓여야 다시 요약한다(창의 95%를 넘으면 예외). 토큰은 utf-8 바이트/3으로 보수 추정.

export const DEFAULT_CONTEXT_TOKENS = 128_000; // 카탈로그에 창 값이 없는 모델 — 보수적으로
export const COMPACT_AT = 0.75;
export const COMPACT_EMERGENCY_AT = 0.95;
export const COMPACT_KEEP_TURNS = 20;
export const COMPACT_MIN_NEW_TURNS = 10;
export const COMPACT_SUMMARY_TOKENS = 4000;
const SUMMARY_TEXT_CAP = 16_000; // 지시를 넘겨 길게 와도 전사에 싣는 상한(글자)
const RENDER_BLOCK_CAP = 1500;   // 요약 입력에서 도구 결과·긴 글 한 블록의 상한(글자)

export const estimateTokens = (x) => Math.ceil(Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x ?? ''), 'utf8') / 3);

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

const summaryBlock = (text, lang) => ({ type: 'text', text: lang === 'en'
  ? `[Summary of the earlier conversation — it grew long, so the earlier part was summarized. Continue from this summary and the conversation that follows]\n${text}\n[End of summary]`
  : `[앞 대화 요약 — 대화가 길어져 앞부분을 요약했다. 이 요약과 이어지는 대화를 바탕으로 이어서 일하라]\n${text}\n[요약 끝]` });

/** 필요하면 전사를 압축한다(sess.messages 교체). 반환 { compacted, trimmed, preTokens }.
    summarize(prompt) → 요약 글(같은 러너 원샷). 실패·빈 답이면 앞부분을 예산까지 잘라낸다. 중단(aborted)은 그대로 던진다. */
export async function compactTranscript(sess, { system = '', tools = [], window = DEFAULT_CONTEXT_TOKENS, summarize, lang = 'ko' }) {
  const fixed = estimateTokens(system) + estimateTokens(tools);
  const size = (msgs) => fixed + estimateTokens(msgs);
  const preTokens = size(sess.messages);
  if (preTokens <= window * COMPACT_AT) return { compacted: false, trimmed: false, preTokens };
  const cut = tailStart(sess.messages);
  if (cut <= 0) return { compacted: false, trimmed: false, preTokens }; // 최근 20턴뿐 — 지금의 글자 수 절단(saveNativeSession)만 적용
  const head = sess.messages.slice(0, cut); const tail = sess.messages.slice(cut);
  const headTurns = head.filter(isPrompt).length;
  if (sess.compacted && headTurns < COMPACT_MIN_NEW_TURNS && preTokens <= window * COMPACT_EMERGENCY_AT) return { compacted: false, trimmed: false, preTokens };
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
