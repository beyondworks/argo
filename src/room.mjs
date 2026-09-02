// 회의실 — 사장 + 여러 크루가 한 방에서 대화한다(맥락 공유가 눈에 보이는 곳).
// @멘션한 크루가 답하고, 뒤 순서 크루는 앞 크루의 발언을 보고 보탠다. 회의 내용은 각 턴의 일지로 회사 기억이 된다.
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { chat } from './chat.mjs';
import { setTurnStatus, clearTurnStatus, getTurnStatus } from './turn-status.mjs';
import { maskKeyLike } from './runners/shared.mjs';
import { updateIndex } from './memory.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson, salvageFromCorrupt } from './jsonstore.mjs';
import { CC_MAX, sendCrewMail } from './crewmail.mjs';
import { resetStamp, resumeStamp } from './reset-stamp.mjs';

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
  // 같은 분 안에 두 번 마치면(다시 열기→마치기, 짧은 회의 연속) HHMM 이름이 같아 앞 회의록이 **덮였다**(격리 실측
  // 2026-09-02: DELETE 2회가 같은 journal/…-1953.md를 반환, 파일엔 뒤 회의만). 회의록은 vault/journal 일지 = 회사 기억이라
  // 유실이 곧 기억 유실. 주제 노트(saveNote create)·옵시디언 임포트(reserve)와 같은 접미 규칙(-2, -3)으로 빈 이름을 잡되,
  // 판정은 exists 검사가 아니라 배타 생성(wx — 이름 기준 원자 연산, 심링크 선점도 EEXIST)으로 한다: 동기화 풀이 먼저
  // 내려놓은 같은 이름을 **여기서** 덮지 않는다(반대 방향 — pull이 방금 쓴 회의록을 덮는 경로 — 는 sync.mjs의 기존
  // 동작으로 이 변경 범위 밖). 최종 이름에 직접 쓰므로 tmp→rename 원자성은 없다(종전과 동급 — 배타 생성은 최종
  // 이름에 걸려야 성립해 writeFileAtomic으로 대체 불가). 초 단위 시각으로 바꾸지 않는 이유: 같은 초 재발 가능 +
  // 일지 파일명 규약(HHMM)과 어긋난다.
  await mkdir(p.journal, { recursive: true });
  const stem = `${day}-회의록-${hm}`;
  let journalName = `${stem}.md`;
  for (let n = 2; ; n += 1) {
    try { await writeFile(join(p.journal, journalName), md, { flag: 'wx' }); break; }
    catch (e) {
      // EEXIST 외(EACCES·ENOSPC 등)는 그대로 던진다 — 삼키면 무한 루프이고, 회의실 락(withLock 체인)이 영원히 settle
      // 되지 않아 그 회사의 마치기·다시 열기·회의 턴이 프로세스 수명 내내 멈춘다(분리 검수가 EACCES로 실증).
      if (e?.code !== 'EEXIST') throw e;
      // 상한 — 어떤 결함(접미 미증가 등)이든 매달리지 않고 예외로 끝나게. 같은 분에 회의록 999개는 사용이 아니다.
      if (n > 999) throw new Error(`회의록 이름을 잡지 못했습니다 — journal/에 ${stem} 계열이 999개 이상`);
      journalName = `${stem}-${n}.md`;
    }
  }
  await updateIndex(wsId).catch(() => {});
  const dir = join(p.chats, '.archive');
  await writeJsonAtomic(join(dir, `_room-${Date.now()}.json`), room);
  // sid 증가 — 진행 중이던 runRoomTurn의 잔여 발언이 빈 방에 유령으로 남지 않도록 무효화한다
  // resetAt — 크루 채팅의 '새 대화'와 같은 tombstone(검수 MEDIUM-2: 회의실도 isThread라 같은
  // union 병합을 타는데 각인이 없어, '회의 마치기'가 동기화로 되살아났다 — 실측 재현).
  // 산식은 src/reset-stamp.mjs(벽시계 미사용 — 시계 앞선 기기가 남의 메시지를 자르는 것 방지).
  await saveRoom(wsId, { messages: [], ...resetStamp(room), sid: (room.sid ?? 0) + 1 });
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

    알려진 한계: 마칠 때 남긴 일지(회의록)는 그대로 둔다. 다시 마치면 회의록이 하나 더 쌓인다(같은 분이면
    -2 접미 — endMeetingLocked) — 일지는 append-only 기록이라 "두 번 마쳤다"는 사실 자체가 맞고, 지우는 건
    기억 유실이라 안 한다. */
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
    // 되살림 각인 — 없으면 endMeeting이 남긴 **원격 tombstone**이 이겨 되살린 회의가 다음 병합에서
    // 통째로 잘린다(분리 검수 2R HIGH-1 재현: 2건 → 0건). reopenMeeting은 곧바로 보관본을 지우므로
    // 그 회의는 회의록 md 말고 어디에도 남지 않는다. 크루의 resumeSession과 같은 대칭 계약.
    delete archived.resetAt;
    delete archived.cutTs; // 보관본의 옛 자르기 지점 정리 — thread.mjs resumeSession과 같은 이유(방어적 — 게이트가 먼저 걸려 현재 무행동)
    await saveRoom(wsId, { ...archived, resumedAt: resumeStamp(cur), sid: (cur.sid ?? 0) + 1 });
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

// 멘션의 @ 앞 경계 — **배제**로 정의한다. 걸러야 할 건 이메일 로컬파트뿐인데(lean8kim@gmail.com),
// 허용 문자를 나열하면 따옴표·꺾쇠·콜론 뒤의 정상 멘션("@비스트"님 · <@비스트> · 담당:@비스트)이
// 통째로 빠지고, 그 경우 unknown도 안 서서 **엉뚱한 크루가 답한다**(2R 검수에서 실측된 과교정).
// 룩비하인드는 폭이 0이라 '@a,@b'처럼 붙어 있어도 다음 매치가 앞 문자를 다시 쓴다.
const NOT_EMAIL = '(?<![A-Za-z0-9_.+\\-])';

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
  // 멘션에 붙는 부호는 이름의 일부가 아니다. 닫는 따옴표·괄호에서 **자른다** — 후행 제거만으로는
  // `"@비스트"님`처럼 부호 뒤에 조사가 붙은 형태(`비스트"님`)를 못 푼다. 크루 이름엔 이 부호가 없다.
  const clean = (tok) => String(tok)
    .replace(/^@/, '')
    .split(/["'“”‘’<>()[\]{}「」『』]/)[0]
    .replace(/[.,!?:;·]+$/, '');

  // 멘션이 **아닌** @ — 크루 이름엔 점·슬래시·역슬래시가 없다. 이메일 도메인(gmail.com)과
  // 스코프 패키지(types/node)를 여기서 버린다. unknown에도 넣지 않는다 — 사장이 오타 낸 게
  // 아니라 애초에 멘션이 아니었으므로, 안내를 띄우면 그게 잡음이다(분리 검수 HIGH-1).
  const notAMention = (c) => /[./\\]/.test(c);

  const unknown = [];
  /** 토큰을 크루로 풀어 into에 담는다. 반환: 'all' | 'ok' | 'unknown' | 'skip' */
  const take = (tok, into) => {
    // **원문 먼저, 자른 것은 그다음.** 크루 이름은 사장이 자유 입력이라 괄호·따옴표가 들어갈 수
    // 있고(노바(백엔드) · O'Brien), 회의실 멘션 드롭다운은 slug가 아니라 그 **이름을 넣는다**.
    // 자른 값만 조회하면 앱이 제안한 이름을 앱이 "명단에 없다"고 답한다(4R 검수 실측).
    const raw = String(tok).replace(/^@/, '');
    const c = clean(tok);
    if (/^(all|전체)$/i.test(c)) return 'all';
    if (notAMention(raw)) return 'skip';
    const a = index.get(norm(raw)) ?? index.get(norm(c));
    if (!a) { if (!unknown.includes(c)) unknown.push(c); return 'unknown'; }
    if (!into.some((x) => x.slug === a.slug)) into.push(a);
    return 'ok';
  };

  // 코드블록은 파싱 전에 걷어낸다 — 붙여넣은 코드의 @Override·@media가 멘션으로 읽히면,
  // 안내가 끼어들거나(잡음) 유효 멘션이 없을 때 아무도 답하지 않는다(무응답 회귀).
  let rest = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

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
  let ccAll = false; // 'cc @전체' — 호출부가 전 크루로 펼친다(상한은 거기서)
  rest = rest.replace(/(?:^|\s)(?:cc|참조)[:\s]+((?:@\S+[\s,]*)+)/gi, (_m, group) => {
    for (const tok of group.match(/@\S+/g) ?? []) {
      // 'all'을 버리면 "cc @전체 공유"가 통째로 사라지고, unknown도 안 서서 중단 게이트에도
      // 안 걸려 **첫 크루 한 명이 답해버린다**(분리 검수 MEDIUM-1 — 무증상 오배정).
      if (take(tok, cc) === 'all') ccAll = true;
    }
    return ' ';
  });

  // ③ hop — '@A > @B > @C'. 체인은 하나만 인정한다(여러 갈래 릴레이는 방에서 읽히지 않는다).
  const relay = [];
  rest = rest.replace(new RegExp(`${NOT_EMAIL}@[^\\s@]+(?:\\s*(?:>|→|->)\\s*@[^\\s@]+)+`, 'g'), (m) => {
    if (relay.length) return ' '; // 두 번째 체인은 무시 — 아래 unknown이 아니라 의도적 단순화
    for (const tok of m.match(/@[^\s@]+/g) ?? []) take(tok, relay);
    return ' ';
  });

  // ④ 남은 멘션 = to.
  const to = [];
  let allCall = false;
  for (const m of rest.matchAll(new RegExp(`${NOT_EMAIL}@([^\\s@]+)`, 'g'))) {
    if (take(m[1], to) === 'all') allCall = true;
  }

  return { loop, cc, ccAll, relay: relay.slice(0, HOP_MAX + 1), to, allCall, unknown };
}

/** 회의실 턴 진행 마커 — 크루 채팅의 상태 파일 계약(turn-status.mjs)을 슬러그 'room-main'으로 그대로 쓴다.
    없으면 회의실 화면의 '회의 중' 표시가 **자기 탭의 POST 대기**뿐이라, 안건을 올리고 다른 페이지에 갔다
    돌아오면 서버에서 턴이 돌고 있어도 화면은 멈춘 것처럼 보였다(유건 실사용 제보 2026-09-02).
    부수 효과: 상주 재배포 IDLE 게이트(chats/*.status.json)에 회의실 턴도 잡힌다. */
export const ROOM_TURN_SLUG = 'room-main';
// 같은 방의 동시 턴(탭 2개·API 직접 호출)은 마커 하나를 공유한다 — 먼저 끝난 턴이 지우면 뒤 턴이 도는 동안
// 다음 하트비트(≤30초)까지 표시가 꺼진다(분리 검수 MEDIUM-1, 1/100 축소 모형 실측). 프로세스 내 참조
// 카운트로 마지막 턴만 지운다. 크로스 프로세스 동시 턴은 남지만 ≤30초 자가 치유.
const ROOM_TURNS = new Map(); // wsId → 진행 중 턴 수
/** heartbeatMs — 턴이 도는 동안 마커 ts를 주기 갱신한다. 크루 상태 파일은 스트리밍·도구 이벤트마다 갱신되지만
    'memory'처럼 이벤트가 없는 단계가 2분을 넘기면 마커가 낡아 **턴이 살아 있는데 표시가 꺼진다**
    (격리 실측 2026-09-02: memory 단계 99초 무갱신). 하트비트는 프로세스가 살아 있음 자체의 신호라 단계와
    무관하고, 프로세스가 죽으면 멈춰 2분 뒤 만료된다(고아 방어). unref — 프로세스 종료를 잡지 않는다. */
export async function withRoomTurnStatus(wsId, fn, { heartbeatMs = 30_000 } = {}) {
  ROOM_TURNS.set(wsId, (ROOM_TURNS.get(wsId) ?? 0) + 1);
  await setTurnStatus(wsId, ROOM_TURN_SLUG, 'room', '');
  // 틱은 직렬화 + alive 게이트 — 해제(finally) 직후 **진행 중이던 틱**이 마커를 되살리면 화면이 2분간
  // 거짓 '회의 중'이 된다. 하중은 `await tick`(진행 중 틱을 기다린 뒤 지움)에 있다 — 분리 검수 HIGH-1이
  // 지연 주입으로 확정 red를 실증했고, 테스트는 heartbeatMs:1 × 40회 반복으로 잠근다.
  let alive = true; let tick = Promise.resolve();
  const beat = async () => {
    if (!alive) return;
    const cur = await getTurnStatus(wsId, ROOM_TURN_SLUG); // 하트비트가 도는 한 2분 창 안 — 발언자(detail) 보존용
    if (!alive) return;
    await setTurnStatus(wsId, ROOM_TURN_SLUG, 'room', cur?.detail ?? '');
  };
  const hb = setInterval(() => { tick = tick.then(beat).catch(() => {}); }, heartbeatMs);
  hb.unref?.();
  try { return await fn(); }
  finally {
    alive = false; clearInterval(hb); await tick; // 진행 중 틱 완료 후에만 해제
    const left = (ROOM_TURNS.get(wsId) ?? 1) - 1;
    if (left > 0) ROOM_TURNS.set(wsId, left);
    else { ROOM_TURNS.delete(wsId); await clearTurnStatus(wsId, ROOM_TURN_SLUG); } // 마지막 턴만 — 성공·실패·중단 모두
  }
}
/** 회의실 턴 진행 여부(화면 복원용) = 마커가 2분 안에 갱신됐는가, 단일 판정. 하트비트(30초)가 긴 발언을
    덮으므로 발언자 상태로 이어 판정하는 폴백은 두지 않는다 — 두면 크래시로 남은 마커 + 무관한 개인 채팅
    턴이 최대 30분 거짓 '회의 중'을 만든다(분리 검수 HIGH-2: 3/10/25/29분 전 마커 전부 ACTIVE 실측). */
export async function getRoomTurn(wsId) {
  const s = await getTurnStatus(wsId, ROOM_TURN_SLUG);
  return s ? { active: true, slug: s.detail || null, startedAt: s.startedAt } : null;
}

export async function runRoomTurn(wsId, text, attachments = []) {
  return withRoomTurnStatus(wsId, async () => {
    // saved — 사장 발언이 방에 저장된 **뒤** 난 오류에 표식을 단다. 라우트가 오류 바디에 싣고, 화면은 이
    // 값으로 "입력창에 되돌릴지"를 가른다: 저장됐으면 되돌리지 않는다(되돌리면 방과 입력창에 같은 안건이
    // 나란히 남아 Enter 한 번에 두 번 적립·과금 — 분리 검수 #392 HIGH-1 실측), 저장 전 실패(크루 0명 등)면
    // 되돌린다(안 그러면 폴링이 낙관 말풍선까지 지워 글이 완전히 사라진다). chat 라우트의 {error, saved} 계약과 동형.
    const state = { saved: false };
    try { return await runRoomTurnInner(wsId, text, attachments, state); }
    catch (e) { if (state.saved && e && typeof e === 'object') e.saved = true; throw e; }
  });
}
async function runRoomTurnInner(wsId, text, attachments, state = {}) {
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
  state.saved = true; // 여기서부터의 실패는 "안건은 저장됨" — 화면이 입력을 되돌리지 않게(runRoomTurn 주석)

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
        loop: { maxRuns: 20 }, // 자율 루프 기본 상한 — 회차마다 LOOP 판정으로 스스로 끝내고, 20회에서 자동 정지
      });
      await sys('loop', en
        ? `Loop registered — @${target.slug} every ${r.schedule.everyMinutes} min, up to ${r.loop?.maxRuns ?? 20} runs. Manage it in Routines.`
        : `루프 등록 — @${target.slug}, ${r.schedule.everyMinutes}분마다, 최대 ${r.loop?.maxRuns ?? 20}회. 관리는 '루틴' 화면에서.`);
    } catch (e) {
      // 간격 하한(10분) 등 검증 실패 — 사유를 방에 그대로 돌려준다
      await sys('loop', en ? `Loop not registered: ${String(e.message || e)}` : `루프 등록 실패: ${String(e.message || e)}`);
    }
    return { replies: [], room: await loadRoom(wsId) };
  }

  // ── cc — 방에서 말하지 않는다. 회의 발언을 참조 사본으로 우편함에 넣는다.
  //    **비용 주의**: 참조받은 크루는 조용히 읽는 게 아니라 스케줄러가 배달하며 자기 턴을 새로
  //    태운다(scheduler.mjs — 쪽지 1건 = LLM 턴 1회). "cc"라는 말이 싸 보여서 사장이 그 비용을
  //    인지하기 어렵기 때문에 crewmail의 CC_MAX를 여기에도 건다(분리 검수 MEDIUM-2).
  //    회의실 cc는 수신자마다 쪽지를 따로 만들어 crewmail 내부 상한 검사에 걸리지 않는다.
  const speaking = [...dir.to, ...dir.relay]; // 방에서 이미 말하는 크루는 참조 쪽지까지 또 태우지 않는다
  const ccTargets = dir.ccAll ? agents.filter((a) => !speaking.some((x) => x.slug === a.slug)) : dir.cc;
  if (ccTargets.length) {
    const bossName = en ? 'the captain' : '사장';
    const capped = ccTargets.slice(0, CC_MAX);
    const dropped = ccTargets.slice(CC_MAX); // 누가 빠졌는지 이름으로 밝힌다 — 숫자만으론 확인할 길이 없다
    const ok = [];
    for (const a of capped) {
      try {
        await sendCrewMail(wsId, {
          from: 'captain', fromName: bossName, fromRole: 'captain',
          to: a.slug, kind: 'cc',
          message: en ? `(Room) ${text}` : `(회의실) ${text}`,
        });
        ok.push(a);
      } catch (e) { console.warn(`[argo] 회의실 참조 전달 실패(${a.slug}):`, e.message); }
    }
    if (ok.length) {
      // 잘렸으면 반드시 말한다 — 참조가 조용히 빠지면 사장은 전달된 줄 안다
      const cut = dropped.length ? (en ? ` (not CC'd: ${dropped.map((a) => a.name).join(', ')} — CC limit ${CC_MAX})` : ` (제외: ${dropped.map((a) => a.name).join(', ')} — 참조는 ${CC_MAX}명까지)`) : '';
      await sys('cc', en
        ? `CC → ${ok.map((a) => a.name).join(', ')} — they pick this up on their own next turn.${cut}`
        : `참조 → ${ok.map((a) => a.name).join(', ')} — 각자 다음 턴에 읽습니다(방에서는 발언하지 않습니다).${cut}`);
    }
  }

  // ── 발언자 결정. relay(hop)면 그 순서 그대로, @전체면 전원, 아니면 기존 규칙(멘션 없으면 첫 크루).
  const speakers = dir.relay.length
    ? dir.relay
    : dir.allCall ? agents : (dir.to.length ? dir.to : [agents[0]]).slice(0, 3);
  const isRelay = dir.relay.length > 0;
  // 참조만 지시했으면 여기서 끝 — 참조만 돌리려던 문장에 엉뚱한 크루가 답하지 않게.
  if (!speakers.length || (ccTargets.length && !dir.to.length && !dir.relay.length && !dir.allCall)) {
    return { replies: [], room: await loadRoom(wsId) };
  }

  const nameOf = (slug) => agents.find((x) => x.slug === slug)?.name ?? slug;
  // @all × 이미지 첨부 = 크루 수만큼 이미지 토큰이 곱해진다(검수 LOW — 이미지는 턴마다 임베드).
  // 앞 3명까지만 임베드하고 이후 발언자는 경로 노트로 받는다 — 파일은 vault/files에 있으니 필요한
  // 크루는 Read로 열람 가능. 이름 멘션 경로는 speakers 자체가 3명 상한이라 이 캡에 걸리지 않는다.
  const IMG_EMBED_MAX = 3;
  // 이 턴만의 식별자 — sid는 회의 세션이라 턴마다 같다. 같은 방에서 턴이 겹치면(탭 2개·API 직접
  // 호출) 키가 완전히 같아져 서로의 위임 이벤트를 주워 담는다(분리 검수 MEDIUM-3).
  const turnId = `${sid}-${Math.random().toString(36).slice(2, 8)}`;
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
    const mirrorCtx = { room: `${turnId}:${a.slug}:${i}` };
    const mirrored = [];
    const { onNotify } = await import('./notify.mjs');
    const off = onNotify((ev) => {
      if (ev?.type === 'delegate' && ev.wsId === wsId && ev.ctx?.room === mirrorCtx.room) mirrored.push(ev);
    });
    let r;
    try {
      await setTurnStatus(wsId, ROOM_TURN_SLUG, 'room', a.slug); // 발언자 갱신 — 화면 복원의 신선도 앵커(getRoomTurn)
      // 첨부는 발언 크루 전원에게 전달 — chat()이 attNote로 프롬프트에 싣고 파일은 vault/files에 이미 있다
      r = await chat(wsId, a.slug, prompt, null, { source: 'room', attachments: att, mirrorCtx });
    } catch (e) {
      // 발언 실패를 **방에 남긴다** — 오류는 POST 호출 탭에만 돌아가므로, 안건을 올리고 다른 페이지로 간
      // 사장에게는 방이 그냥 조용해져 "멈췄다"로 보였다(실사용 제보 2026-09-02 계열 — 격리 실측: 401 실패 190초
      // 뒤 방에 흔적 0). 시스템 줄(sys)은 크루 프롬프트 트랜스크립트에서 제외되는 기존 규약이라 대화를 오염하지 않는다.
      const msg = maskKeyLike(String(e?.message || e).replace(/\s+/g, ' ')).slice(0, 200); // 방 스레드는 동기화·회의록 적재 대상 — 키 모양은 가린다
      await sys('error', en ? `${a.name} could not respond: ${msg}` : `${a.name} 발언 실패: ${msg}`).catch(() => {});
      throw e; // 호출 탭의 오류 표시 계약은 그대로
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
    // ponytail: 회의실 턴을 크루 개인 스레드에 기록한다 — 마지막 남은 비대칭(루틴 #157 교훈).
    // 안 하면 회의에서 시킨 일이 개인 채팅에 안 보이고 이어가기가 안 된다(유건 제보 2026-08-08).
    const { appendTurn } = await import('./thread.mjs');
    await appendTurn(wsId, a.slug, { userMsg: prompt, reply: r.reply, handover: r.handover, sessionId: null, via: 'room', artifacts: r.artifacts })
      .catch((e) => console.error(`[argo] 회의실 스레드 기록 실패(${wsId}/${a.slug}):`, e.message));
    replies.push({ slug: a.slug, name: a.name, reply: r.reply });
  }
  return { replies, room: await loadRoom(wsId) };
}
