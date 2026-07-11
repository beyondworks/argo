// 회의실 — 사장 + 여러 크루가 한 방에서 대화한다(맥락 공유가 눈에 보이는 곳).
// @멘션한 크루가 답하고, 뒤 순서 크루는 앞 크루의 발언을 보고 보탠다. 회의 내용은 각 턴의 일지로 회사 기억이 된다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { chat } from './chat.mjs';

const file = (wsId) => join(paths(wsId).chats, 'room-main.json');

export async function loadRoom(wsId) {
  try {
    return JSON.parse(await readFile(file(wsId), 'utf8'));
  } catch {
    return { messages: [] };
  }
}

async function saveRoom(wsId, room) {
  await mkdir(paths(wsId).chats, { recursive: true });
  await writeFile(file(wsId), JSON.stringify(room, null, 2));
}

/** 사장 발언 1건 → 멘션된 크루가 순서대로 응답(폭주 방지: 최대 3명). 멘션 없으면 첫 크루. */
export async function runRoomTurn(wsId, text) {
  const agents = await listAgents(wsId);
  if (!agents.length) throw new Error('아직 크루가 없습니다. 데크에서 먼저 영입해 주세요.');
  const room = await loadRoom(wsId);
  room.messages.push({ who: 'user', text, ts: Date.now() });
  await saveRoom(wsId, room);

  const mentioned = [];
  for (const m of text.matchAll(/@(\S+)/g)) {
    const key = m[1].toLowerCase();
    const a = agents.find((x) => x.slug === key || x.name.toLowerCase() === key);
    if (a && !mentioned.some((y) => y.slug === a.slug)) mentioned.push(a);
  }
  const speakers = (mentioned.length ? mentioned : [agents[0]]).slice(0, 3);

  const nameOf = (slug) => agents.find((x) => x.slug === slug)?.name ?? slug;
  const replies = [];
  for (const a of speakers) {
    // 매 발언 직전 최신 트랜스크립트 — 뒤 크루는 앞 크루의 답을 보고 겹치지 않게 보탠다
    const transcript = (await loadRoom(wsId)).messages.slice(-20)
      .map((m) => `${m.who === 'user' ? '사장' : nameOf(m.who)}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`)
      .join('\n');
    const prompt = `지금 회의실에 있다 — 사장과 동료 크루가 함께 보는 방이다.

## 회의 대화 (최근)
${transcript}

## 지시
사장의 마지막 발언에 "${a.name}"로서 답하라. 동료가 이미 말한 내용은 반복하지 말고 너의 전문성으로 보태라. 회의 발언답게 5줄 이내로 간결히.`;
    const r = await chat(wsId, a.slug, prompt, null, { source: 'room' });
    const cur = await loadRoom(wsId);
    cur.messages.push({ who: a.slug, text: r.reply, ts: Date.now() });
    await saveRoom(wsId, cur);
    replies.push({ slug: a.slug, name: a.name, reply: r.reply });
  }
  return { replies, room: await loadRoom(wsId) };
}
