// 채팅 스레드 영속화 — 크루별 chats/<slug>.json 에 대화·세션을 남긴다.
// 새로고침해도 대화가 이어지는 것이 제품의 기본 자세다.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${slug.replace(/[^a-z0-9-]/g, '')}.json`);

export async function loadThread(wsId, slug) {
  try {
    return JSON.parse(await readFile(file(wsId, slug), 'utf8'));
  } catch {
    return { sessionId: null, messages: [] };
  }
}

export async function appendTurn(wsId, slug, { userMsg, reply, handover, sessionId, attachments }) {
  const t = await loadThread(wsId, slug);
  const ts = Date.now();
  t.messages.push(
    { who: 'user', text: userMsg, ts, ...(attachments?.length ? { attachments } : {}) },
    { who: 'crew', text: reply, handover, ts },
  );
  t.sessionId = sessionId ?? t.sessionId;
  await mkdir(paths(wsId).chats, { recursive: true });
  await writeFile(file(wsId, slug), JSON.stringify(t, null, 2));
  return t;
}

/** 새 대화 — 스레드와 세션을 함께 비운다. vault 기억은 그대로다(그게 제품의 핵심). */
export async function resetThread(wsId, slug) {
  await rm(file(wsId, slug), { force: true });
}
