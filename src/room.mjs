// 회의실 — 사장 + 여러 크루가 한 방에서 대화한다(맥락 공유가 눈에 보이는 곳).
// @멘션한 크루가 답하고, 뒤 순서 크루는 앞 크루의 발언을 보고 보탠다. 회의 내용은 각 턴의 일지로 회사 기억이 된다.
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { chat } from './chat.mjs';
import { updateIndex } from './memory.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson, salvageFromCorrupt } from './jsonstore.mjs';

const file = (wsId) => join(paths(wsId).chats, 'room-main.json');
// sync가 chats/room-main.json을 쓸 때 쓰는 락 키(thread:ws:room-main)와 동일하게 맞춘다 —
// 동기화 풀과 로컬 회의 쓰기가 같은 파일을 경쟁할 때 상호배제되도록(락 키가 다르면 배제 실패).
const rkey = (wsId) => `thread:${wsId}:room-main`;
// 회의 아카이브 접두사 — 크루 slug는 [a-z0-9-]라 '_'를 못 쓰므로, 크루 세션 아카이브와 절대 겹치지 않는다
const MEETING_RE = /^_room-\d+\.json$/;

export async function loadRoom(wsId) {
  // 회의 대화는 유실이 치명적 — 손상을 조용히 빈 방으로 리셋하지 않고 throw로 드러낸다(readJson).
  const room = await readJson(file(wsId), { messages: [] });
  // 파일이 아예 없을 때만(= 손상 격리 직후) 손상본에서 건져 **화면에만** 되돌린다 — 손상 후 다음
  // 로드부터 영구히 "빈 회의실"이 되던 유실 경로(신고 2026-07-25)의 복구.
  // 파일이 있으면(회의 마치기로 비운 정상 상태 포함) 건드리지 않는다 — 유령 부활 차단(검수 CRITICAL-1).
  // 파일 쓰기는 하지 않는다 — 동기화 self-heal이 원격 완전본으로 되살릴 기회를 남긴다(검수 CRITICAL-2).
  if (!room.messages?.length) {
    const s = await salvageFromCorrupt(file(wsId), 'messages').catch(() => null);
    if (s) return { ...room, messages: s.items, salvagedFrom: s.from };
  }
  return room;
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
        title: r.title ?? null,  // 사장이 붙인 회의명(있으면 레일에서 topic 대신 표시) — 채팅 세션과 동일 규약
        pinned: r.pinned === true, // 고정 회의 — 레일 상단에 최근순으로 묶인다
        topic: String(first?.text ?? '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 보관본은 건너뛴다 */ }
  }
  // 고정 먼저, 그 안에서 최근순 — 채팅 세션 레일과 동일 정렬
  return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
}

export async function readArchivedMeeting(wsId, id) {
  if (!MEETING_RE.test(id)) throw new Error('잘못된 회의 id');
  return JSON.parse(await readFile(join(paths(wsId).chats, '.archive', id), 'utf8'));
}

/** 회의명 편집 — 보관 회의 파일에 title 기록(레일 표시는 title 우선, 없으면 topic). 채팅 renameSession과 동일 계약. */
export async function renameMeeting(wsId, id, title) {
  if (!MEETING_RE.test(id)) throw new Error('잘못된 회의 id');
  return withLock(rkey(wsId), async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const r = JSON.parse(await readFile(f, 'utf8'));
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (clean) r.title = clean; else delete r.title;
    await writeJsonAtomic(f, r);
    return { id, title: r.title ?? null };
  });
}

/** 회의 고정/해제 — 보관 회의 파일에 pinned 기록. 채팅 setPinned와 동일 계약. */
export async function setMeetingPinned(wsId, id, pinned) {
  if (!MEETING_RE.test(id)) throw new Error('잘못된 회의 id');
  return withLock(rkey(wsId), async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const r = JSON.parse(await readFile(f, 'utf8'));
    if (pinned) r.pinned = true; else delete r.pinned;
    await writeJsonAtomic(f, r);
    return { id, pinned: r.pinned === true };
  });
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

${room.messages.map((m) => `**${m.who === 'user' ? '사장' : nameOf(m.who)}**: ${String(m.text).trim()}${m.attachments?.length ? `\n> 첨부: ${m.attachments.map((a) => 'vault/' + a.rel).join(', ')}` : ''}`).join('\n\n')}
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

/** 회의 다시 열기 — 보관된 회의를 현재 방으로 되돌려 이어서 대화한다(실사용 요청 2026-07-26).
    "마치기"로 적재한 뒤 빠진 얘기가 생각나면 새 회의를 여는 수밖에 없었다.

    설계 결정 3가지:
    1. **현재 방이 비어 있을 때만** 연다. 진행 중 회의를 자동으로 마치고 덮으면 사장이 의도하지 않은
       일지 적재가 생긴다 — 거절하고 "먼저 마치기"를 안내하는 쪽이 정직하다.
    2. **방을 먼저 쓰고, 그다음 보관본을 지운다.** 순서를 뒤집으면 쓰기 실패 시 회의가 증발한다.
       이 순서면 최악이 "레일에 중복 표시"(눈에 보이고 복구 가능) — 오차를 비파괴 방향으로 낸다.
    3. **sid를 올린다.** 빈 방에서 돌던 잔여 턴의 발언이 되살린 회의에 유령으로 끼어들지 않게
       (endMeeting과 같은 이유).

    알려진 한계: 마칠 때 남긴 일지(회의록)는 그대로 둔다. 다시 마치면 회의록이 하나 더 쌓인다 —
    일지는 append-only 기록이라 "두 번 마쳤다"는 사실 자체가 맞고, 지우는 건 기억 유실이라 안 한다. */
export async function reopenMeeting(wsId, id) {
  return withLock(rkey(wsId), async () => {
    const cur = await loadRoom(wsId);
    if (cur.messages?.length) {
      const e = new Error('진행 중인 회의가 있습니다 — 먼저 "회의 마치기"로 정리한 뒤 다시 열어 주세요.');
      e.code = 'ROOM_BUSY';
      throw e;
    }
    const archived = await readArchivedMeeting(wsId, id); // 없으면 여기서 throw — 방을 건드리기 전이다
    if (!archived?.messages?.length) throw new Error('비어 있는 보관 회의는 열 수 없습니다.');
    await saveRoom(wsId, { ...archived, sid: (cur.sid ?? 0) + 1 });
    await rm(join(paths(wsId).chats, '.archive', id), { force: true }).catch(() => {}); // 실패해도 유실 아님(중복 표시)
    return { reopened: true, messages: archived.messages.length };
  });
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

export async function runRoomTurn(wsId, text, attachments = []) {
  const agents = await listAgents(wsId);
  if (!agents.length) throw new Error('아직 크루가 없습니다. 데크에서 먼저 영입해 주세요.');
  // 사장 발언 추가 + 현재 세션 sid 확보(이후 발언은 이 sid가 유지될 때만 기록)
  const sid = await withLock(rkey(wsId), async () => {
    const room = await loadRoom(wsId);
    const s = room.sid ?? 0;
    room.messages.push({ who: 'user', text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) });
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
  // @all/@전체 — 전 크루 호출(명시적 요청이므로 3명 폭주 상한을 적용하지 않는다). 이름 멘션은 기존 상한 유지.
  const allCall = /@(all|전체)(?=\s|$)/i.test(text);
  const speakers = allCall ? agents : (mentioned.length ? mentioned : [agents[0]]).slice(0, 3);

  const nameOf = (slug) => agents.find((x) => x.slug === slug)?.name ?? slug;
  // @all × 이미지 첨부 = 크루 수만큼 이미지 토큰이 곱해진다(검수 LOW — 이미지는 턴마다 임베드).
  // 앞 3명까지만 임베드하고 이후 발언자는 경로 노트로 받는다 — 파일은 vault/files에 있으니 필요한
  // 크루는 Read로 열람 가능. 이름 멘션 경로는 speakers 자체가 3명 상한이라 이 캡에 걸리지 않는다.
  const IMG_EMBED_MAX = 3;
  const replies = [];
  for (const [i, a] of speakers.entries()) {
    const att = i >= IMG_EMBED_MAX && attachments.some((x) => x.isImage)
      ? attachments.map((x) => (x.isImage ? { ...x, isImage: false } : x))
      : attachments;
    // 매 발언 직전 최신 트랜스크립트 — 뒤 크루는 앞 크루의 답을 보고 겹치지 않게 보탠다
    const transcript = (await loadRoom(wsId)).messages.slice(-20)
      // 첨부 경로 규약은 chat.mjs 스레드 맥락과 동일 문자열 — 후속 턴에서 "아까 그 파일"이 경로로
      // 이어진다(검수 M1: 이게 없으면 1턴 첨부를 2턴 크루가 못 찾는다 — 랜덤 접두 파일명이라 탐색 불가).
      .map((m) => `${m.who === 'user' ? '사장' : nameOf(m.who)}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}${m.attachments?.length ? ` (첨부, Read로 열람: ${m.attachments.map((a) => 'vault/' + a.rel).join(', ')})` : ''}`)
      .join('\n');
    const prompt = `지금 회의실에 있다 — 사장과 동료 크루가 함께 보는 방이다.

## 회의 대화 (최근)
${transcript}

## 지시
사장의 마지막 발언에 "${a.name}"로서 답하라.
- **실제 작업을 요청받았으면 이 턴에서 바로 실행하라.** "~하겠다 / 라우팅하겠다 / 착수하겠다" 같은 계획·약속으로 끝내지 마라 — 사장은 답을 지금 기다린다.
- 동료의 전문(검수·리뷰·다른 분야)이 필요하면 **말로만 "맡기겠다"고 하지 말고 delegate 도구(to=동료 slug, task=구체 지시)로 실제로 위임해** 그 동료의 결과를 받아 네 답에 통합하고, 어느 동료 작업인지 밝혀라.
- 확정 정보가 부족하면 되묻기만 하고 멈추지 말고, 합리적 가정을 명시한 뒤 그 방향으로 **실제 산출물/검토 결과까지 만들어** 답하라.
- 단순 논의·의견이면 동료가 이미 말한 건 반복 말고 네 전문성으로 간결히 보태라(이 경우엔 5줄 이내).`;
    // 첨부는 발언 크루 전원에게 전달 — chat()이 attNote로 프롬프트에 싣고 파일은 vault/files에 이미 있다
    const r = await chat(wsId, a.slug, prompt, null, { source: 'room', attachments: att });
    const live = await pushRoomMsg(wsId, { who: a.slug, text: r.reply, ts: Date.now() }, sid);
    if (!live) break; // 회의가 마쳐졌다 — 남은 발언을 빈 방에 남기지 않는다
    replies.push({ slug: a.slug, name: a.name, reply: r.reply });
  }
  return { replies, room: await loadRoom(wsId) };
}
