// 스레드 맥락 토큰 예산 — 세션을 이어받지 못하는 턴(외부 CLI 러너: codex exec·gemini -p·agy, 그리고 Claude SDK·네이티브의 다른 기기 이어받기)은
// 스레드 기록을 글로 붙여 대화를 잇는다. 종전에는 최근 6개 메시지만 붙여 조금만 지나도 앞 대화를 잃었다.
// 규칙: 최근 대화를 예산(CTX_BUDGET_TOKENS, utf-8 바이트/3 보수 추정) 안에서 최대한 넣고, 예산 밖 오래된 부분은 스레드에 저장한
// 누적 요약 {text, upto}로 넣는다. upto = 요약이 덮는 마지막 메시지의 ts — 그 메시지가 스레드에 없으면(새 대화·회수·삭제) 요약은 무효다.
// 비용 상한: 요약은 예산 밖에 요약 안 된 메시지가 SUMMARY_REFRESH_MIN개 이상 쌓였을 때만 1회 갱신한다(턴마다 요약 호출 금지).
// 요약이 실패하면 요약 없이 예산 안 최근 대화만 넣는다(있던 유효한 요약은 그대로 싣는다 — 그 범위에서는 여전히 맞다).
// 실패는 기억한다(memoKey): 실패 시점의 요약 대상 끝(ts) 뒤로 새 메시지가 SUMMARY_REFRESH_MIN개 쌓이기 전에는 다시 부르지 않는다 —
// 기억이 없으면 고장 난 러너에서 턴마다 요약 원샷(최대 90초 동기)을 다시 걸었다(분리 검수 MEDIUM).

export const CTX_BUDGET_TOKENS = 24_000;
export const SUMMARY_REFRESH_MIN = 20;
export const SUMMARY_INPUT_MAX_TOKENS = 60_000; // 요약 원샷 입력 상한 — 넘으면 요약 안 된 몫 가운데 오래된 줄부터 뺀다
const SUMMARY_TEXT_CAP = 16_000;

export const estTokens = (s) => Math.ceil(Buffer.byteLength(String(s ?? ''), 'utf8') / 3);

// 요약 실패 기억 — 키(회사:크루:범위) → { upto: 실패 때 요약하려던 마지막 메시지 ts, at }. 프로세스 메모리에만 둔다:
// 스레드 파일에 쓰면 실패 표지 하나마다 쓰기·동기화 업로드가 따라온다(DB 보호 규칙). 재시작하면 한 번 다시 시도할 뿐이다.
// globalThis — Next가 이 모듈을 진입점(라우트·게이트웨이)마다 따로 싣는다(turn-abort.mjs 등록부와 같은 이유).
const failMemo = (globalThis.__argoThreadSummaryFail ??= new Map());

/** 계획(순수) — msgs는 범위·필터가 끝난 시간순 메시지. 최근(예산 안)·요약 안 된 오래된 몫·유효 요약을 나눈다. */
export function planContext(msgs, lineOf, { budget = CTX_BUDGET_TOKENS, summary = null } = {}) {
  const lines = msgs.map(lineOf);
  let used = 0; let start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = estTokens(lines[i]) + 1; // +1 = 줄바꿈
    if (used + c > budget) break;
    used += c; start = i;
  }
  const anchor = summary && typeof summary.text === 'string' && summary.text.trim() ? msgs.findIndex((m) => m.ts === summary.upto) : -1;
  const valid = anchor >= 0;
  const pendingFrom = valid ? anchor + 1 : 0;
  const pending = pendingFrom < start ? msgs.slice(pendingFrom, start) : [];
  return {
    recent: lines.slice(start), // 예산 안 최근 줄
    pending, pendingLines: lines.slice(pendingFrom, Math.max(pendingFrom, start)), // 예산 밖, 요약이 아직 덮지 않은 몫
    summary: valid ? summary.text : null,
    needRefresh: pending.length >= SUMMARY_REFRESH_MIN,
  };
}

/** 요약 원샷 지시문(순수) */
export function threadSummaryPrompt(prevSummary, lines, lang = 'ko') {
  const kept = lines.slice();
  let total = kept.reduce((a, l) => a + estTokens(l), 0);
  while (kept.length > 1 && total > SUMMARY_INPUT_MAX_TOKENS) total -= estTokens(kept.shift());
  const prev = prevSummary ? (lang === 'en' ? `Earlier summary:\n${prevSummary}\n\nConversation after it:\n` : `이전 요약:\n${prevSummary}\n\n그 뒤 대화:\n`) : '';
  return lang === 'en'
    ? `Below is an earlier part of the conversation between the captain and a crew member. Summarize it so the crew can keep working without the original: decisions made, work in progress or promised, file paths, names, numbers and preferences the captain stated. Fold any earlier summary in. Write at most 4000 tokens and output only the summary.\n\n<conversation>\n${prev}${kept.join('\n')}\n</conversation>`
    : `아래는 사장과 크루가 나눈 대화의 앞부분이다. 원문 없이도 크루가 이어서 일할 수 있게 요약하라: 정한 것, 진행 중이거나 약속한 일, 나온 파일 경로·이름·숫자, 사장이 밝힌 선호. 이전 요약이 있으면 합쳐라. 최대 4000토큰으로, 요약문만 출력하라.\n\n<conversation>\n${prev}${kept.join('\n')}\n</conversation>`;
}

/** 맥락 만들기 — 필요하면 요약을 1회 갱신하고 save로 저장한다. 반환 { recent: 줄들(문자열), summary: 글|null }.
    summarize(prompt) → 글(그 크루의 같은 러너 원샷), save({text, upto}) → 스레드 저장. 둘 다 실패해도 던지지 않는다(맥락은 턴을 죽이지 않는다).
    중단(aborted)만은 그대로 던진다 — 사장이 멈춘 턴을 요약 실패로 삼켜 이어 가면 안 된다. memoKey가 있으면 실패를 기억한다(위 failMemo). */
export async function buildThreadContext({ msgs, lineOf, summary = null, summarize, save, budget = CTX_BUDGET_TOKENS, lang = 'ko', memoKey = null }) {
  const plan = planContext(msgs, lineOf, { budget, summary });
  let text = plan.summary;
  const failed = memoKey ? failMemo.get(memoKey) : null;
  // 실패 뒤 새로 쌓인 몫 — 요약 대상(pending) 가운데 실패 시점의 끝보다 새 메시지. 이것이 SUMMARY_REFRESH_MIN개가 되기 전에는 다시 부르지 않는다
  const retryable = !failed || plan.pending.filter((m) => m.ts > failed.upto).length >= SUMMARY_REFRESH_MIN;
  if (plan.needRefresh && summarize && retryable) {
    try {
      const out = String(await summarize(threadSummaryPrompt(plan.summary, plan.pendingLines, lang)) ?? '').trim();
      if (!out) throw new Error('empty summary');
      if (memoKey) failMemo.delete(memoKey);
      const next = { text: out.slice(0, SUMMARY_TEXT_CAP), upto: plan.pending.at(-1).ts };
      text = next.text;
      await Promise.resolve(save?.(next)).catch((e) => console.warn(`[argo] 대화 요약 저장 실패(이번 턴에는 싣는다): ${String(e?.message ?? e).slice(0, 120)}`));
    } catch (e) {
      if (e?.aborted) throw e;
      if (memoKey) failMemo.set(memoKey, { upto: plan.pending.at(-1).ts, at: Date.now() });
      console.warn(`[argo] 대화 요약 실패 — 요약 없이 최근 대화만 싣는다(새 메시지 ${SUMMARY_REFRESH_MIN}개가 더 쌓이면 다시 시도): ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  return { recent: plan.recent.join('\n'), summary: text || null };
}

/** 프롬프트 구획(순수) — 요약(있으면) + 최근 대화. head는 최근 대화 머리말(호출부마다 다르다). 둘 다 없으면 ''. */
export function contextSection({ recent, summary }, head, lang = 'ko') {
  const sum = summary ? `## ${lang === 'en' ? 'Summary of the earlier conversation (automatic — older part)' : '앞 대화 요약 (자동 — 오래된 부분)'}\n${summary}\n\n` : '';
  if (!recent && !sum) return '';
  return `${sum}${recent ? `## ${head}\n${recent}\n` : ''}`;
}
