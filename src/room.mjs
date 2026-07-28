// 회의실 — 사장 + 여러 크루가 한 방에서 대화한다(맥락 공유가 눈에 보이는 곳).
// @멘션한 크루가 답하고, 뒤 순서 크루는 앞 크루의 발언을 보고 보탠다. 회의 내용은 각 턴의 일지로 회사 기억이 된다.
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
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

/** 연쇄 상한 — delegate·crewmail과 같은 값(2). 회의실 릴레이도 같은 규칙을 따른다. */
export const HOP_MAX = 2;

/** 회의실 라우팅 지시 파서 — 사장이 **방을 떠나지 않고** to·cc·hop·loop를 건다
    (유건 지시 2026-07-28: "회의실이 아니라 그룹채팅 개념. 이 공간을 벗어나지 않고 멘션을 통해서
    to/cc/hop/loop 기능으로 업무가 가능해야 한다").
    의미는 크루 쪽지(crewmail)와 **같은 것**을 쓴다 — 사장이 익힐 규칙이 한 벌이어야 한다.

      @이름              to   이번 턴에 방에서 답한다
      @전체 / @all       to   전 크루
      @A > @B            hop  A가 답한 뒤 그 답을 물고 B가 잇는다(최대 HOP_MAX단)
      cc @이름           cc   방에선 말하지 않고 참조 사본만 받는다(다음 자기 턴에 읽음 — 쪽지 cc와 동일)
      loop 30분 @이름 …  loop 그 지시를 N분 주기 루틴으로 등록

    순수 함수(단위 테스트용). 못 알아본 멘션은 unknown으로 돌려준다 — 조용히 무시하면
    사장은 지시가 먹은 줄 안다(무증상 실패가 가장 비싸다). */
export function parseRoomDirectives(text, agents = []) {
  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim(); // 한글 NFC/NFD 방어
  const index = new Map();
  for (const a of agents) { index.set(norm(a.slug), a); index.set(norm(a.name), a); }
  // 멘션 뒤에 붙는 문장부호는 이름의 일부가 아니다("@비스트," → "비스트")
  const clean = (tok) => String(tok).replace(/^@/, '').replace(/[.,!?:;)\]}]+$/, '');

  const unknown = [];
  /** 토큰을 크루로 풀어 into에 담는다. 반환: 'all' | 'ok' | 'unknown' */
  const take = (tok, into) => {
    const c = clean(tok);
    if (/^(all|전체)$/i.test(c)) return 'all';
    const a = index.get(norm(c));
    if (!a) { if (!unknown.includes(c)) unknown.push(c); return 'unknown'; }
    if (!into.some((x) => x.slug === a.slug)) into.push(a);
    return 'ok';
  };

  let rest = String(text ?? '');

  // ① loop — **문두에서만** 잡는다. 문장 중간의 "반복"은 그냥 낱말이지 지시가 아니다.
  let loop = null;
  // 경계는 \b가 아니라 전방탐색이다 — 한글(분·시간)은 \w가 아니라서 \b가 성립하지 않고,
  // 그러면 단위 그룹이 통째로 버려져 "2시간"이 2분이 된다(실측 후 수정). 긴 단위를 먼저 시도한다.
  const loopM = rest.match(/^\s*(?:loop|루프|반복)\s+(\d+)\s*(분|시간|mins|min|hrs|hr|m|h)?(?=[\s@]|$)\s*/i);
  if (loopM) {
    const n = Number(loopM[1]);
    const isHour = /^(시간|h|hr|hrs)$/i.test(loopM[2] ?? '');
    loop = { everyMinutes: isHour ? n * 60 : n };
    rest = rest.slice(loopM[0].length);
  }

  // ② cc — 'cc @a @b' / '참조 @a, @b'. 먼저 걷어내야 아래 to 수집에 섞이지 않는다.
  const cc = [];
  rest = rest.replace(/(?:^|\s)(?:cc|참조)[:\s]+((?:@\S+[\s,]*)+)/gi, (_m, group) => {
    for (const tok of group.match(/@\S+/g) ?? []) take(tok, cc);
    return ' ';
  });

  // ③ hop — '@A > @B > @C'. 체인은 하나만 인정한다(여러 갈래 릴레이는 방에서 읽히지 않는다).
  const relay = [];
  rest = rest.replace(/@\S+(?:\s*(?:>|→|->)\s*@\S+)+/g, (m) => {
    if (relay.length) return ' '; // 두 번째 체인은 무시 — 아래 unknown이 아니라 의도적 단순화
    for (const tok of m.match(/@\S+/g) ?? []) take(tok, relay);
    return ' ';
  });

  // ④ 남은 멘션 = to
  const to = [];
  let allCall = false;
  for (const tok of rest.match(/@\S+/g) ?? []) {
    if (take(tok, to) === 'all') allCall = true;
  }

  return { loop, cc, relay: relay.slice(0, HOP_MAX + 1), to, allCall, unknown };
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

  const dir = parseRoomDirectives(text, agents);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  const en = lang === 'en';
  const sys = (kind, body) => pushRoomMsg(wsId, { who: 'system', kind, text: body, ts: Date.now() }, sid);

  // 못 알아본 멘션은 먼저 알린다 — 조용히 넘기면 사장은 지시가 먹은 줄 안다.
  if (dir.unknown.length) {
    await sys('unknown', en
      ? `No crew named ${dir.unknown.map((u) => `@${u}`).join(', ')}. Available: ${agents.map((a) => a.slug).join(', ')}`
      : `@${dir.unknown.join(', @')} 는 크루 명단에 없습니다. 가능한 이름: ${agents.map((a) => a.slug).join(', ')}`);
    // 부른 이름을 하나도 못 풀었으면 여기서 멈춘다. "멘션 없으면 첫 크루" 폴백에 걸리면
    // 사장이 지목하지도 않은 크루가 답하고, 오타는 그 답에 묻혀 안 보인다.
    if (!dir.to.length && !dir.relay.length && !dir.cc.length && !dir.allCall && !dir.loop) {
      return { replies: [], room: await loadRoom(wsId) };
    }
  }

  // ── loop — 주기 루틴으로 등록하고 이번 턴은 발언 없이 끝낸다(등록과 실행을 섞지 않는다).
  if (dir.loop) {
    const target = dir.relay[0] ?? dir.to[0] ?? (dir.allCall ? agents[0] : null);
    if (!target) {
      await sys('loop', en ? 'Mention the crew who should run the loop (e.g. loop 30m @slug ...).' : '루프를 돌 크루를 함께 멘션해 주세요 (예: 반복 30분 @슬러그 ...).');
      return { replies: [], room: await loadRoom(wsId) };
    }
    // 파서와 같은 패턴이어야 한다 — 어긋나면 지시문에 "반복 30분"이 남아 루틴이 자기를 또 등록하려 든다
    const prompt = text.replace(/^\s*(?:loop|루프|반복)\s+\d+\s*(?:분|시간|mins|min|hrs|hr|m|h)?(?=[\s@]|$)\s*/i, '').trim();
    try {
      const { addRoutine } = await import('./routines.mjs');
      const r = await addRoutine(wsId, {
        agentSlug: target.slug,
        title: (prompt.replace(/@\S+/g, '').trim() || (en ? 'Room loop' : '회의실 루프')).slice(0, 60),
        prompt, schedule: { type: 'interval', everyMinutes: dir.loop.everyMinutes },
      });
      await sys('loop', en
        ? `Loop registered — @${target.slug} every ${r.schedule.everyMinutes} min. Manage it in Routines.`
        : `루프 등록 — @${target.slug}, ${r.schedule.everyMinutes}분마다. 관리는 '루틴' 화면에서.`);
    } catch (e) {
      // 간격 하한(10분) 등 검증 실패 — 사유를 방에 그대로 돌려준다
      await sys('loop', en ? `Loop not registered: ${String(e.message || e)}` : `루프 등록 실패: ${String(e.message || e)}`);
    }
    return { replies: [], room: await loadRoom(wsId) };
  }

  // ── cc — 방에서 말하지 않는다. 회의 발언을 참조 사본으로 우편함에 넣어 다음 자기 턴에 읽게 한다
  //    (쪽지 cc와 같은 의미: "알아두라고 보낸 사본, 회신 의무 없다"). 방에는 안내 한 줄만 남는다.
  if (dir.cc.length) {
    const bossName = en ? 'the captain' : '사장';
    const ok = [];
    for (const a of dir.cc) {
      try {
        const { sendCrewMail } = await import('./crewmail.mjs');
        await sendCrewMail(wsId, {
          from: 'captain', fromName: bossName, fromRole: 'captain',
          to: a.slug, kind: 'cc',
          message: en ? `(Room) ${text}` : `(회의실) ${text}`,
        });
        ok.push(a);
      } catch (e) { console.warn(`[argo] 회의실 참조 전달 실패(${a.slug}):`, e.message); }
    }
    if (ok.length) {
      await sys('cc', en
        ? `CC → ${ok.map((a) => a.name).join(', ')} — they will read this on their next turn (no reply expected).`
        : `참조 → ${ok.map((a) => a.name).join(', ')} — 다음 자기 턴에 읽습니다(발언은 하지 않습니다).`);
    }
  }

  // ── 발언자 결정. relay(hop)면 그 순서 그대로, @전체면 전원, 아니면 기존 규칙(멘션 없으면 첫 크루).
  const speakers = dir.relay.length
    ? dir.relay
    : dir.allCall ? agents : (dir.to.length ? dir.to : [agents[0]]).slice(0, 3);
  const isRelay = dir.relay.length > 0;
  // cc만 있고 발언 대상이 없으면 여기서 끝 — 참조만 돌리려던 지시에 엉뚱한 크루가 답하지 않게.
  if (!speakers.length || (dir.cc.length && !dir.to.length && !dir.relay.length && !dir.allCall)) {
    return { replies: [], room: await loadRoom(wsId) };
  }

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
    // 매 발언 직전 최신 트랜스크립트 — 뒤 크루는 앞 크루의 답을 보고 겹치지 않게 보탠다.
    // 시스템 안내(참조·루프·오타 멘션)는 사람에게 주는 줄이라 프롬프트에서 뺀다 — 크루가 답할 대상이 아니다.
    const transcript = (await loadRoom(wsId)).messages.filter((m) => m.who !== 'system').slice(-20)
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
- 단순 논의·의견이면 동료가 이미 말한 건 반복 말고 네 전문성으로 간결히 보태라(이 경우엔 5줄 이내).${
      isRelay && i > 0
        ? `\n- **이어받기(릴레이)**: 사장이 "${speakers[i - 1].name} → ${a.name}" 순서를 지정했다. 바로 앞 ${speakers[i - 1].name}의 답을 출발점으로 삼아 네 몫을 이어서 완성하라 — 처음부터 다시 하지 말고, 앞 결과의 무엇을 받아 무엇을 더했는지 밝혀라.`
        : ''
    }${
      isRelay && i < speakers.length - 1
        ? `\n- 네 답 다음에는 ${speakers[i + 1].name}이(가) 이어받는다. 넘길 것을 분명히 남겨라.`
        : ''
    }`;
    // 위임을 방 안에서 보이게 한다 — 지금까지 크루가 회의 중 delegate하면 그 대화는 상대 크루의
    // **개인 채팅 스레드**에만 적재되고 방엔 최종 답만 왔다. 사장 눈에는 "각자 다른 창으로 흩어졌다
    // 돌아오는" 것으로 보인다(유건 지시 2026-07-28의 핵심 불만). 텔레그램 그룹이 쓰던 위임 미러
    // (gateway.mjs delegate 이벤트)와 같은 방식을 인앱 회의실에도 건다.
    // mirrorCtx로 **이 턴의 위임만** 받는다 — 동시에 도는 다른 턴의 위임이 이 방에 섞이지 않게.
    const mirrorCtx = { room: `${sid}:${a.slug}:${i}` };
    const mirrored = [];
    const { onNotify } = await import('./notify.mjs');
    const off = onNotify((ev) => {
      if (ev?.type === 'delegate' && ev.wsId === wsId && ev.ctx?.room === mirrorCtx.room) mirrored.push(ev);
    });
    let r;
    try {
      // 첨부는 발언 크루 전원에게 전달 — chat()이 attNote로 프롬프트에 싣고 파일은 vault/files에 이미 있다
      r = await chat(wsId, a.slug, prompt, null, { source: 'room', attachments: att, mirrorCtx });
    } finally {
      // emitNotify는 마이크로태스크로 핸들러를 돌린다 — 턴 종료 직후 한 틱 양보해야 마지막 위임을 놓치지 않는다
      await new Promise((res) => setTimeout(res, 0));
      off();
    }
    // 위임 결과를 **답변보다 먼저** 방에 남긴다 — 실제 일어난 순서(위임 → 그걸 반영한 답)와 같게.
    for (const ev of mirrored) {
      const live = await pushRoomMsg(wsId, {
        who: ev.to, text: ev.reply, ts: Date.now(),
        via: { from: ev.from, fromName: ev.fromName, task: String(ev.task ?? '').slice(0, 200) },
      }, sid);
      if (!live) return { replies, room: await loadRoom(wsId) }; // 회의가 마쳐졌다
    }
    const live = await pushRoomMsg(wsId, { who: a.slug, text: r.reply, ts: Date.now() }, sid);
    if (!live) break; // 회의가 마쳐졌다 — 남은 발언을 빈 방에 남기지 않는다
    replies.push({ slug: a.slug, name: a.name, reply: r.reply });
  }
  return { replies, room: await loadRoom(wsId) };
}
