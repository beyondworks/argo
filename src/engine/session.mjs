// 네이티브 엔진 세션(대화 전사) 저장 — 기기 로컬(SDK 세션 저장소와 같은 지역성). 파일: <회사>/.sessions/native/<slug>.json
// 도트 디렉터리라 동기화 대상이 아니다(.runner-health.json·.tg-claims와 같은 관례). 스레드(chats/)가 사용자 가시 기억이고
// 이 파일은 모델 문맥 연속성만 맡는다 — 없어지면 새 세션으로 시작할 뿐 턴이 죽지 않는다(SDK의 'No conversation found'와 다름).
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '../workspace.mjs';
import { readJson, writeJsonAtomic } from '../jsonstore.mjs';
import { carrySummary, countPrompts } from './compact.mjs';

export const sessionFile = (wsId, slug) => join(paths(wsId).root, '.sessions', 'native', `${slug}.json`);

// ponytail: 문맥 예산은 JSON 길이로 근사(토큰 아님). 넘치면 앞 턴부터 버린다 — 정밀 예산은 모델별 컨텍스트 창을 알게 되면.
export const SESSION_MAX_CHARS = 400_000;
/** 이미지 1장의 base64 상한 — 전사 상한 안에서 지시·도구 결과가 남게(≤ SESSION_MAX_CHARS의 80%, 테스트가 절대값으로 잠근다). 넘으면 브라우저는 품질 사다리로 줄이고, 그래도 넘으면 파일로만. */
export const IMAGE_MAX_B64 = 300_000;
export const SESSION_TRIM_TO = 300_000;

/** 전사 절단(순수) — 앞에서부터 버리되, 남은 첫 메시지가 tool_result만 든 user 메시지가 되지 않게 맞춘다
    (assistant tool_use 없는 tool_result는 API가 거절한다). */
const IMAGE_DROPPED = { type: 'text', text: '(이전 스크린샷은 전사에서 생략 — 저장 파일 참조)' };
/** 이미지 블록은 최신 1개만 남기고 나머지는 자리표시 텍스트로(순수). 스크린샷 한 장(base64 60만 자)이 상한을 넘겨 전사를 통째로
    비우던 실사고(분리 검수 HIGH-1)의 1차 처방 — 오래된 화면은 모델에 더 필요 없다. */
export function dropOldImages(messages) {
  let keep = null;
  for (let i = messages.length - 1; i >= 0 && keep === null; i--) {
    const c = messages[i]?.content; if (!Array.isArray(c)) continue;
    for (const b of c) { const inner = b?.type === 'tool_result' && Array.isArray(b.content) ? b.content : [b]; if (inner.some((x) => x?.type === 'image')) { keep = i; break; } }
  }
  return messages.map((m, i) => {
    if (i === keep || !Array.isArray(m?.content)) return m;
    const strip = (arr) => arr.map((x) => (x?.type === 'image' ? IMAGE_DROPPED : x));
    return { ...m, content: m.content.map((b) => (b?.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: strip(b.content) } : b?.type === 'image' ? IMAGE_DROPPED : b)) };
  });
}
// 지시 = 글이 있고 tool_result가 없는 user. 끼워 넣기(native-query steerNote)는 tool_result 뒤에 글을 붙이므로, "비tool_result 블록이 하나라도"로
// 판정하면 그 도구 결과 메시지가 절단 뒤 머리로 남아 짝 없는 tool_result → 다음 턴 벤더 400이 반복된다(검수 4, 2026-09-29).
const isPromptMsg = (m) => m?.role === 'user' && (Array.isArray(m.content) ? m.content.some((b) => b?.type !== 'tool_result') && !m.content.some((b) => b?.type === 'tool_result') : true);
export function trimMessages(messages, maxChars = SESSION_MAX_CHARS, trimTo = SESSION_TRIM_TO) {
  let out = messages.slice();
  const size = () => JSON.stringify(out).length;
  if (size() <= maxChars) return out;
  out = dropOldImages(out);
  while (out.length > 2 && size() > trimTo) out.shift();
  while (out.length && !isPromptMsg(out[0])) out.shift();
  // 불변식: 실제 지시(user·비tool_result)가 하나라도 있는 전사는 절대 비지 않는다 — 비면 다음 벤더 호출이 messages:[]로 나가 400·턴 사망
  // (분리 검수 HIGH-1 실루프 재현). 머리 정리가 전부 걷어냈으면 마지막 실제 지시를 되살린다(이미지는 뺀 채). 지시가 전무한 전사(엔진 경로에선 도달 불가 —
  // run()이 프롬프트를 먼저 push하고 resume은 sanitize가 머리를 보장)는 빈 배열이 맞다(4R LOW: 보장 범위를 정직히 적는다).
  if (!out.length) { const last = [...messages].reverse().find(isPromptMsg); if (last) out = dropOldImages([last]).map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => (b?.type === 'image' ? IMAGE_DROPPED : b)) : m.content })); }
  return out;
}

/** 전사 정리(순수) — 이전 턴이 도중에 죽어 남긴 꼬리를 걷어낸다(분리 검수 HIGH-2 실측: 짝 없는 tool_use·답 없는 user가
    다음 턴에 그대로 벤더로 가면 400/역할 연속). 규칙: ① assistant의 tool_use는 바로 다음 user에 대응 tool_result가 전부 있어야
    한다(없으면 그 assistant부터 절단) ② 꼬리의 user 메시지(답 없는 지시·tool_result)는 버린다 ③ 첫 메시지는 user다. */
export function sanitizeTranscript(messages) {
  const out = (messages ?? []).slice();
  // 꼬리 정리와 짝 검사는 서로를 다시 만든다(tool_result를 버리면 그 앞 tool_use가 짝을 잃는다) — 안정될 때까지 반복
  let prev = -1;
  while (out.length !== prev) {
    prev = out.length;
    for (let i = 0; i < out.length; i++) {
      const m = out[i]; if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const ids = m.content.filter((b) => b?.type === 'tool_use').map((b) => b.id);
      if (!ids.length) continue;
      const next = out[i + 1];
      const got = next?.role === 'user' && Array.isArray(next.content) ? next.content.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id) : [];
      if (!ids.every((id) => got.includes(id))) { out.length = i; break; }
    }
    while (out.length && out.at(-1).role === 'user') out.pop();
  }
  // 머리는 텍스트를 품은 user여야 한다 — tool_result만 든 user가 머리에 남으면 짝 없는 결과(재검수 LOW, trimMessages와 같은 술어)
  while (out.length && !isPromptMsg(out[0])) out.shift();
  return out;
}

/** 세션 로드 — resumeId가 파일의 id와 같을 때만 이어간다. 아니면(첫 턴·다른 기기·파일 유실) 새 id로 시작. 이어갈 때 전사를 정리한다. */
export async function loadNativeSession(wsId, slug, resumeId = null) {
  const f = sessionFile(wsId, slug);
  const saved = await readJson(f, null).catch(() => null);
  if (saved && resumeId && saved.id === resumeId && Array.isArray(saved.messages)) return { id: saved.id, messages: sanitizeTranscript(saved.messages), resumed: true, ...(saved.compacted ? { compacted: true } : {}), ...(Number.isInteger(saved.compactBase) ? { compactBase: saved.compactBase } : {}) }; // compacted·compactBase — 압축 간격 규칙(compact.mjs)
  return { id: `native-${randomUUID()}`, messages: [], resumed: false };
}

/** 턴 중 저장(K57) — 넘치면 오래된 스크린샷 정리를 전체에 먼저, 그 뒤 마지막 지시 앞(이전 턴)만 예산까지 절단한다.
    현재 턴(마지막 지시~꼬리)은 손대지 않는다 — 전체를 trimMessages로 자르면 큰 도구 결과가 든 현재 턴이 지시 하나로 줄어
    모델이 같은 작업(쓰기·쪽지·제출)을 처음부터 반복했다. 현재 턴 단독으로 상한을 넘으면 넘긴 채 저장한다(알려진 한계).
    tail은 지시로 시작하므로 head가 비어도 전사는 비지 않고 머리가 지시다 — trimMessages의 마지막 지시 복원은 쓰지 않는다(연속 user 방지).
    이 상한은 base64까지 글자로 센다(압축 추정은 이미지를 고정값으로 센다 — compact.mjs TRANSCRIPT_BUDGET_TOKENS 주석). 그래서 스크린샷이 든 세션은
    압축보다 이 절단이 먼저 와 앞부분이 **요약 없이** 사라질 수 있다. 맨 앞 요약 블록(직전 압축의 결과)만은 잃지 않게 남은 첫 지시 앞에 다시 붙인다(carrySummary,
    재검수 MEDIUM 재현: 요약 머리가 잘려 저장 뒤 요약 없음). 잘라낸 지시 수만큼 compactBase도 줄여 압축 간격(새로 생긴 지시 수)이 어긋나지 않게 한다. */
export async function saveNativeSession(wsId, slug, sess) {
  let messages = sess.messages.slice();
  const size = (a) => JSON.stringify(a).length;
  if (size(messages) > SESSION_MAX_CHARS) {
    const before = messages;
    messages = dropOldImages(messages);
    const cut = Math.max(0, messages.findLastIndex(isPromptMsg));
    const head = messages.slice(0, cut); const tail = messages.slice(cut); const tailSize = size(tail);
    while (head.length && size(head) + tailSize > SESSION_TRIM_TO) head.shift();
    while (head.length && !isPromptMsg(head[0])) head.shift();
    messages = sess.compacted ? carrySummary(before, [...head, ...tail]) : [...head, ...tail]; // 요약 블록은 압축된 세션에만 있다
    if (Number.isInteger(sess.compactBase)) sess.compactBase = Math.max(0, sess.compactBase - (countPrompts(before) - countPrompts(messages)));
  }
  await writeJsonAtomic(sessionFile(wsId, slug), { id: sess.id, at: Date.now(), messages, ...(sess.compacted ? { compacted: true } : {}), ...(Number.isInteger(sess.compactBase) ? { compactBase: sess.compactBase } : {}) });
  sess.messages = messages;
}
