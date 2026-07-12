// 회의실 — 사장 + 여러 크루가 한 방에서 대화한다(맥락 공유가 눈에 보이는 곳).
// @멘션한 크루가 답하고, 뒤 순서 크루는 앞 크루의 발언을 보고 보탠다. 회의 내용은 각 턴의 일지로 회사 기억이 된다.
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { chat } from './chat.mjs';
import { updateIndex } from './memory.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';

const file = (wsId) => join(paths(wsId).chats, 'room-main.json');
// sync가 chats/room-main.json을 쓸 때 쓰는 락 키(thread:ws:room-main)와 동일하게 맞춘다 —
// 동기화 풀과 로컬 회의 쓰기가 같은 파일을 경쟁할 때 상호배제되도록(락 키가 다르면 배제 실패).
const rkey = (wsId) => `thread:${wsId}:room-main`;
// 회의 아카이브 접두사 — 크루 slug는 [a-z0-9-]라 '_'를 못 쓰므로, 크루 세션 아카이브와 절대 겹치지 않는다
const MEETING_RE = /^_room-\d+\.json$/;

export async function loadRoom(wsId) {
  // 회의 대화는 유실이 치명적 — 손상을 조용히 빈 방으로 리셋하지 않고 throw로 드러낸다(readJson).
  return readJson(file(wsId), { messages: [] });
}

async function saveRoom(wsId, room) {
  await writeJsonAtomic(file(wsId), room);
}

/** 지난 회의 목록 — "회의 마치기"로 적재된 방들(최신순). 회의실 좌측 레일의 원천. */
export async function listArchivedMeetings(wsId) {
  const dir = join(paths(wsId).chats, '.archive');
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => MEETING_RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(await readFile(join(dir, n), 'utf8'));
      const first = (r.messages ?? []).find((m) => m.who === 'user');
      out.push({
        id: n,
        ts: Number(n.match(/^_room-(\d+)\.json$/)[1]),
        count: r.messages?.length ?? 0,
        topic: String(first?.text ?? '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 보관본은 건너뛴다 */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function readArchivedMeeting(wsId, id) {
  if (!MEETING_RE.test(id)) throw new Error('잘못된 회의 id');
  return JSON.parse(await readFile(join(paths(wsId).chats, '.archive', id), 'utf8'));
}

/** 회의 마치기 — 회의록을 일지(vault/journal)로 남겨 회사 기억으로 적재하고, 방은 보관 후 비운다(회의 1건 = 적재 1건). */
export async function endMeeting(wsId) {
  return withLock(rkey(wsId), () => endMeetingLocked(wsId));
}
async function endMeetingLocked(wsId) {
  const room = await loadRoom(wsId);
  if (!room.messages?.length) return { archived: false };
  const agents = await listAgents(wsId);
  const nameOf = (slug) => agents.find((x) => x.slug === slug)?.name ?? slug;
  const p = paths(wsId);
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hm = now.toTimeString().slice(0, 5).replace(':', '');
  const topic = String(room.messages[0]?.text ?? '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 30) || '안건 미기재';
  const attendees = [...new Set(room.messages.filter((m) => m.who !== 'user').map((m) => nameOf(m.who)))];
  const md = `# ${day} 회의록 — ${topic}

참석: 사장${attendees.length ? `, ${attendees.join(', ')}` : ''}

${room.messages.map((m) => `**${m.who === 'user' ? '사장' : nameOf(m.who)}**: ${String(m.text).trim()}`).join('\n\n')}
`;
  const journalName = `${day}-회의록-${hm}.md`;
  await mkdir(p.journal, { recursive: true });
  await writeFile(join(p.journal, journalName), md);
  await updateIndex(wsId).catch(() => {});
  const dir = join(p.chats, '.archive');
  await writeJsonAtomic(join(dir, `_room-${Date.now()}.json`), room);
  // sid 증가 — 진행 중이던 runRoomTurn의 잔여 발언이 빈 방에 유령으로 남지 않도록 무효화한다
  await saveRoom(wsId, { messages: [], sid: (room.sid ?? 0) + 1 });
  return { archived: true, journal: `journal/${journalName}` };
}

/** 사장 발언 1건 → 멘션된 크루가 순서대로 응답(폭주 방지: 최대 3명). 멘션 없으면 첫 크루. */
// 락 안에서 방을 읽어 sid가 맞을 때만 메시지 추가. sid 불일치(회의 마침)면 false — 발언을 버린다.
async function pushRoomMsg(wsId, msg, expectSid) {
  return withLock(rkey(wsId), async () => {
    const room = await loadRoom(wsId);
    if (expectSid !== undefined && (room.sid ?? 0) !== expectSid) return false;
    room.messages.push(msg);
    await saveRoom(wsId, room);
    return true;
  });
}

export async function runRoomTurn(wsId, text) {
  const agents = await listAgents(wsId);
  if (!agents.length) throw new Error('아직 크루가 없습니다. 데크에서 먼저 영입해 주세요.');
  // 사장 발언 추가 + 현재 세션 sid 확보(이후 발언은 이 sid가 유지될 때만 기록)
  const sid = await withLock(rkey(wsId), async () => {
    const room = await loadRoom(wsId);
    const s = room.sid ?? 0;
    room.messages.push({ who: 'user', text, ts: Date.now() });
    await saveRoom(wsId, room);
    return s;
  });

  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase(); // 한글 NFC/NFD 불일치 방어
  const mentioned = [];
  for (const m of text.matchAll(/@(\S+)/g)) {
    const key = norm(m[1]);
    const a = agents.find((x) => norm(x.slug) === key || norm(x.name) === key);
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
    const live = await pushRoomMsg(wsId, { who: a.slug, text: r.reply, ts: Date.now() }, sid);
    if (!live) break; // 회의가 마쳐졌다 — 남은 발언을 빈 방에 남기지 않는다
    replies.push({ slug: a.slug, name: a.name, reply: r.reply });
  }
  return { replies, room: await loadRoom(wsId) };
}
