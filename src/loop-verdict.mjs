// 루프 회차 판정 표지 — 답변 **마지막 줄**의 `LOOP: continue` / `LOOP: done <이유>` / `LOOP: blocked <필요한 결정>`.
// 표지를 요구하는 문구(routines.mjs 루프 프로토콜), 엔진 판정(parseLoopVerdict), 1:1 화면의 표시용 제거(stripLoopVerdict)가
// 이 모듈 하나를 쓴다 — 셋 중 하나만 바뀌어 화면에 표지가 새거나 엔진이 못 읽는 일이 없게. 노드 의존 0(클라이언트 번들에서도 가져다 쓴다).

/** 표지 한 줄 — 루프 프로토콜 지시문이 이 모양을 요구한다. rest = 이유·필요한 결정(앞 공백 포함) */
export const loopVerdictLine = (verdict, rest = '') => `LOOP: ${verdict}${rest}`;

/** 회차 판정 마커 정규식(export: 테스트·프롬프트 문구 앵커) */
export const LOOP_VERDICT_RE = /^\s*`?\s*LOOP\s*:\s*(continue|done|blocked)\b[\s.:\-—]*(.*?)\s*`?\s*[.。]?\s*$/i;

/** 답변에서 판정 추출 — 마지막 비어있지 않은 줄만 본다. 마커가 없으면 { verdict:'continue', missing:true } —
    형식을 안 지킨 러너를 곧바로 정지시키지 않는다(연속 누락 상한은 runRoutine이 센다). */
export function parseLoopVerdict(reply) {
  const lines = String(reply ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(LOOP_VERDICT_RE);
  if (!m) return { verdict: 'continue', reason: '', missing: true };
  return { verdict: m[1].toLowerCase(), reason: (m[2] ?? '').trim().slice(0, 300), missing: false };
}

/** 표시용 — 엔진이 판정으로 읽는 마지막 줄 하나만 뺀다(저장 기록·판정은 그대로). 판정 줄이 아니면 원문 그대로 */
export function stripLoopVerdict(text) {
  const s = String(text ?? '');
  const lines = s.split(/\r?\n/);
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i -= 1; // parseLoopVerdict와 같은 '마지막 비어있지 않은 줄'
  if (i < 0 || !LOOP_VERDICT_RE.test(lines[i].trim())) return s;
  return lines.slice(0, i).join('\n').trimEnd();
}
