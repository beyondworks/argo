// 채팅 스레드 영속화 — 크루별 chats/<slug>.json 에 대화·세션을 남긴다.
// 새로고침해도 대화가 이어지는 것이 제품의 기본 자세다.
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
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

/** 참조(cc) 공유 — 대상 크루 스레드에 노트를 남긴다. pending 표시는 "아직 그 크루가 못 본 맥락"이라는 뜻. */
export async function appendSharedNote(wsId, slug, text) {
  const t = await loadThread(wsId, slug);
  t.messages.push({ who: 'user', shared: true, pending: true, text, ts: Date.now() });
  await mkdir(paths(wsId).chats, { recursive: true });
  await writeFile(file(wsId, slug), JSON.stringify(t, null, 2));
}

/** 미소비 공유 노트 회수 — 다음 턴 프롬프트에 1회만 주입되도록 pending을 해제하며 반환한다. */
export async function takeSharedNotes(wsId, slug) {
  const t = await loadThread(wsId, slug);
  const notes = t.messages.filter((m) => m.shared && m.pending);
  if (!notes.length) return [];
  for (const m of notes) delete m.pending;
  await writeFile(file(wsId, slug), JSON.stringify(t, null, 2));
  return notes.map((m) => m.text);
}

/** 보관된 세션 목록 — 새 대화로 적재된 이전 스레드들(최신순). 크루 채팅 좌측 레일의 원천. */
export async function listArchivedSessions(wsId, slug) {
  const dir = join(paths(wsId).chats, '.archive');
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith(`${safe}-`) && n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(join(dir, n), 'utf8'));
      const firstUser = (t.messages ?? []).find((m) => m.who === 'user' && !m.shared);
      out.push({
        id: n,
        ts: Number(n.match(/-(\d+)\.json$/)?.[1] ?? 0),
        count: t.messages?.length ?? 0,
        gist: String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 보관본은 건너뛴다 */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function readArchivedSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!new RegExp(`^${safe}-\\d+\\.json$`).test(id)) throw new Error('잘못된 세션 id');
  return JSON.parse(await readFile(join(paths(wsId).chats, '.archive', id), 'utf8'));
}

/** 새 대화 — 삭제가 아니라 적재. 이전 대화는 chats/.archive/에 보관되고, vault 기억은 그대로다(그게 제품의 핵심). */
export async function resetThread(wsId, slug) {
  const t = await loadThread(wsId, slug);
  if (t.messages?.length) {
    const dir = join(paths(wsId).chats, '.archive');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug.replace(/[^a-z0-9-]/g, '')}-${Date.now()}.json`), JSON.stringify(t, null, 2));
  }
  await rm(file(wsId, slug), { force: true });
}
