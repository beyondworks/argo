// 네이티브 엔진 세션(대화 전사) 저장 — 기기 로컬(SDK 세션 저장소와 같은 지역성). 파일: <회사>/.sessions/native/<slug>.json
// 도트 디렉터리라 동기화 대상이 아니다(.runner-health.json·.tg-claims와 같은 관례). 스레드(chats/)가 사용자 가시 기억이고
// 이 파일은 모델 문맥 연속성만 맡는다 — 없어지면 새 세션으로 시작할 뿐 턴이 죽지 않는다(SDK의 'No conversation found'와 다름).
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from '../workspace.mjs';
import { readJson, writeJsonAtomic } from '../jsonstore.mjs';

export const sessionFile = (wsId, slug) => join(paths(wsId).root, '.sessions', 'native', `${slug}.json`);

// ponytail: 문맥 예산은 JSON 길이로 근사(토큰 아님). 넘치면 앞 턴부터 버린다 — 정밀 예산은 모델별 컨텍스트 창을 알게 되면.
export const SESSION_MAX_CHARS = 400_000;
export const SESSION_TRIM_TO = 300_000;

/** 전사 절단(순수) — 앞에서부터 버리되, 남은 첫 메시지가 tool_result만 든 user 메시지가 되지 않게 맞춘다
    (assistant tool_use 없는 tool_result는 API가 거절한다). */
export function trimMessages(messages, maxChars = SESSION_MAX_CHARS, trimTo = SESSION_TRIM_TO) {
  let out = messages.slice();
  const size = () => JSON.stringify(out).length;
  if (size() <= maxChars) return out;
  while (out.length > 2 && size() > trimTo) out.shift();
  while (out.length && !(out[0].role === 'user' && Array.isArray(out[0].content)
    ? out[0].content.some((b) => b.type !== 'tool_result') : out[0].role === 'user')) out.shift();
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
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** 세션 로드 — resumeId가 파일의 id와 같을 때만 이어간다. 아니면(첫 턴·다른 기기·파일 유실) 새 id로 시작. 이어갈 때 전사를 정리한다. */
export async function loadNativeSession(wsId, slug, resumeId = null) {
  const f = sessionFile(wsId, slug);
  const saved = await readJson(f, null).catch(() => null);
  if (saved && resumeId && saved.id === resumeId && Array.isArray(saved.messages)) return { id: saved.id, messages: sanitizeTranscript(saved.messages), resumed: true };
  return { id: `native-${randomUUID()}`, messages: [], resumed: false };
}

export async function saveNativeSession(wsId, slug, sess) {
  const messages = trimMessages(sess.messages);
  await writeJsonAtomic(sessionFile(wsId, slug), { id: sess.id, at: Date.now(), messages });
  sess.messages = messages;
}
