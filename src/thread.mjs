// 채팅 스레드 영속화 — 크루별 chats/<slug>.json 에 대화·세션을 남긴다.
// 새로고침해도 대화가 이어지는 것이 제품의 기본 자세다.
import { readFile, rm, readdir, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { paths, getDeviceId } from './workspace.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson, salvageFromCorrupt } from './jsonstore.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${slug.replace(/[^a-z0-9-]/g, '')}.json`);
// 같은 크루 스레드의 read-modify-write를 직렬화 — 웹·텔레그램 동시 턴의 lost-update 방지
const lockKey = (wsId, slug) => `thread:${wsId}:${slug.replace(/[^a-z0-9-]/g, '')}`;

/** 스레드 파일 mtime(ms) — 폴링 dedup용. 파일이 없으면 0. */
export async function threadMtime(wsId, slug) {
  try { return (await stat(file(wsId, slug))).mtimeMs; } catch { return 0; }
}

export async function loadThread(wsId, slug) {
  // 대화는 유실이 치명적 — 손상 시 조용히 빈 상태로 리셋하지 않고 throw로 드러낸다(readJson).
  const t = await readJson(file(wsId, slug), { sessionId: null, messages: [] });
  // 회의실과 동일 계약 — 파일 부재일 때만 손상본에서 건져 화면에 되돌리고, 파일은 쓰지 않는다.
  // (새 대화·신규 크루처럼 정상적으로 비어 있는 경우는 파일이 존재하므로 복구가 발동하지 않는다.)
  // sessionId는 복구하지 않는다 — 이어가기 세션은 새로 시작(대화 기록 보존이 우선).
  if (!t.messages?.length) {
    const s = await salvageFromCorrupt(file(wsId, slug), 'messages').catch(() => null);
    if (s) return { ...t, messages: s.items, salvagedFrom: s.from };
  }
  return t;
}

/** 턴 시작 — 사장의 지시를 **답변을 기다리기 전에** 저장한다.
    예전엔 턴이 끝난 뒤에야 appendTurn으로 한꺼번에 저장했다. 그래서 답변을 만드는 동안에는 사장의 글이
    브라우저 메모리에만 있었고, 페이지를 벗어나거나 새로고침하면 **내가 쓴 글이 사라졌다가 답변이
    끝나야 다시 나타났다**(실사용 신고 2026-08-02). 오래 걸리는 턴일수록 오래 사라져 있는 셈이다.
    반환한 turnId로 나중에 같은 줄을 찾아 답변을 붙인다 — 새 줄을 밀어 넣지 않으므로 중복이 없다. */
export async function beginTurn(wsId, slug, { userMsg, attachments, via } = {}) {
  const turnId = `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    t.messages.push({
      who: 'user', text: userMsg, ts: Date.now(), turnId,
      awaiting: true, // 답변 대기 중 — 프롬프트 맥락에서는 뺀다(지금 보내는 그 글이라 두 번 들어간다)
      ...(attachments?.length ? { attachments } : {}),
      ...(via ? { via } : {}),
    });
    await writeJsonAtomic(file(wsId, slug), t);
  });
  return turnId;
}

export async function appendTurn(wsId, slug, { turnId, userMsg, reply, handover, sessionId, attachments, artifacts, via, failed, aborted, fellBack }) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug); // 락 안에서 최신 상태를 다시 읽는다
    const ts = Date.now();
    // beginTurn이 이미 써 둔 줄이 있으면 그 줄을 마무리한다(새로 밀어 넣으면 같은 지시가 두 줄이 된다).
    // 답변은 스레드 끝이 아니라 **그 지시 바로 뒤**에 넣는다 — 턴 도중 도착한 공유 노트가 사이에 끼면
    // 질문과 답이 떨어져 보인다.
    const at = turnId ? t.messages.findIndex((m) => m.turnId === turnId) : -1;
    if (at >= 0) {
      const m = t.messages[at];
      delete m.awaiting;
      if (attachments?.length) m.attachments = attachments;
      if (failed) m.failed = failed;
      if (aborted) m.aborted = true;
      if (!failed) t.messages.splice(at + 1, 0, { who: 'crew', text: reply, handover, ts, ...(artifacts?.length ? { artifacts } : {}), ...(fellBack ? { fellBack } : {}) }); // fellBack = 폴백 투명화(P2) — UI가 대체 실행 안내를 그린다
      if (sessionId) { t.sessionId = sessionId; t.sessionDevice = await getDeviceId().catch(() => t.sessionDevice ?? null); }
      await writeJsonAtomic(file(wsId, slug), t);
      return t;
    }
    t.messages.push(
      // via = 사장이 직접 쓴 글이 아닌 배달 지시(crewmail·delegate·routine). who:'user'는 러너 프롬프트
      // 관점의 역할일 뿐인데 UI가 사장 말풍선으로 그려 "내가 쓴 게 아니거든"이 됐다(신고 2026-07-28).
      // aborted = 사장 지시 중단(사유 문자열과 별도 — 원문이 우연히 'aborted'여도 오판 없음, 재검수 MEDIUM).
      { who: 'user', text: userMsg, ts, ...(attachments?.length ? { attachments } : {}), ...(via ? { via } : {}), ...(failed ? { failed } : {}), ...(aborted ? { aborted: true } : {}) },
    );
    // 실패·중단 턴은 크루 답변이 없다 — 지시문만 사유(failed)와 함께 보존한다. 성공 뒤에만 저장하면
    // 실패 턴의 지시문이 새로고침에 증발하고 비용만 남는다(전수리뷰 2026-07-30 #1).
    // ⚠ "실패 표현"은 두 형태가 공존한다: 이 failed(user 단독 — 답변 자체가 없음)와
    // approval-actions의 실패 사유를 담은 crew 메시지(부작용은 이미 적용돼 보고만 실패). 의도적 구분.
    if (!failed) t.messages.push(
      // artifacts = 이 턴에 크루가 만든/고친 vault 문서(rel) — 답변 칩으로 바로 연다
      { who: 'crew', text: reply, handover, ts, ...(artifacts?.length ? { artifacts } : {}), ...(fellBack ? { fellBack } : {}) }, // 검수 L1 — turnId 없는 갈래(선저장 실패·턴 중 리셋)도 폴백 표식 보존
    );
    if (sessionId) {
      // SDK 세션 저장소는 기기 로컬이라 소유 기기를 함께 기록한다 — 다른 기기가 이 sessionId를
      // resume하면 CLI가 'No conversation found'로 죽는다(실측: 기기 전환 실패). chat이 사전 분기.
      t.sessionId = sessionId;
      t.sessionDevice = await getDeviceId().catch(() => t.sessionDevice ?? null);
    }
    await writeJsonAtomic(file(wsId, slug), t);
    return t;
  });
}

/** 참조(cc) 공유 — 대상 크루 스레드에 노트를 남긴다. pending 표시는 "아직 그 크루가 못 본 맥락"이라는 뜻. */
export async function appendSharedNote(wsId, slug, text) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    t.messages.push({ who: 'user', shared: true, pending: true, text, ts: Date.now() });
    await writeJsonAtomic(file(wsId, slug), t);
  });
}

/** 미소비 공유 노트 회수 — 다음 턴 프롬프트에 1회만 주입되도록 pending을 해제하며 반환한다. */
export async function takeSharedNotes(wsId, slug) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    const notes = t.messages.filter((m) => m.shared && m.pending);
    if (!notes.length) return [];
    for (const m of notes) delete m.pending;
    await writeJsonAtomic(file(wsId, slug), t);
    return notes.map((m) => m.text);
  });
}

/** 소비했던 공유 노트 복원 — 턴이 최종 실패하면 pending을 되살려 다음 턴에 다시 주입한다.
    (소비가 러너 실행 전이라, 복원 없이는 실패한 턴이 cc 맥락을 영구 소실시켰다 — 검증 2026-07-19) */
export async function restoreSharedNotes(wsId, slug, texts) {
  if (!texts?.length) return;
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    const want = new Set(texts);
    for (const m of t.messages) {
      if (m.shared && !m.pending && want.has(m.text)) { m.pending = true; want.delete(m.text); }
    }
    await writeJsonAtomic(file(wsId, slug), t);
  });
}

/** 보관된 세션 목록 — 새 대화로 적재된 이전 스레드들(최신순). 크루 채팅 좌측 레일의 원천. */
export async function listArchivedSessions(wsId, slug) {
  const dir = join(paths(wsId).chats, '.archive');
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  // 엄격 매칭(^slug-<ts>.json$) — startsWith만 쓰면 sales가 sales-lead 아카이브까지 잡아 못 여는 유령 항목이 생긴다
  const re = new RegExp(`^${safe}-\\d+\\.json$`);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => re.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(join(dir, n), 'utf8'));
      // via(배달 지시)는 대화 제목감이 아니다 — 쪽지로 시작된 대화의 제목이 배달 프리픽스가 된다(검수 LOW)
      const firstUser = (t.messages ?? []).find((m) => m.who === 'user' && !m.shared && !m.via);
      out.push({
        id: n,
        ts: Number(n.match(/-(\d+)\.json$/)?.[1] ?? 0),
        count: t.messages?.length ?? 0,
        title: t.title ?? null, // 사용자가 붙인 대화명(있으면 레일에서 gist 대신 표시)
        pinned: t.pinned === true, // 고정 세션 — 레일 상단에 최근순으로 묶인다(title과 동일 in-file 저장)
        gist: String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 보관본은 건너뛴다 */ }
  }
  // 고정 먼저, 그 안에서 최근순 — 각 그룹 내부는 기존과 동일(ts 내림차순)
  return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
}

export async function readArchivedSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!new RegExp(`^${safe}-\\d+\\.json$`).test(id)) throw new Error('잘못된 세션 id');
  return JSON.parse(await readFile(join(paths(wsId).chats, '.archive', id), 'utf8'));
}

/** 새 대화 — 삭제가 아니라 적재. 이전 대화는 chats/.archive/에 보관되고, vault 기억은 그대로다(그게 제품의 핵심). */
export async function resetThread(wsId, slug) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    if (t.messages?.length) {
      const dir = join(paths(wsId).chats, '.archive');
      await writeJsonAtomic(join(dir, `${slug.replace(/[^a-z0-9-]/g, '')}-${Date.now()}.json`), t);
    }
    // 삭제가 아니라 **빈 스레드로 재기록** — 파일 부재는 "손상 격리됨"의 신호로 쓰이므로(loadThread의
    // salvage 게이트), 새 대화가 파일을 지우면 옛 손상본이 되살아난다(검수 CRITICAL-1 C 케이스 실측).
    // 회의실 endMeeting이 {messages:[], sid+1}을 쓰는 것과 같은 계약으로 통일한다.
    await writeJsonAtomic(file(wsId, slug), { sessionId: null, messages: [] });
  });
}

/** 대화 이어가기 — 보관 세션을 다시 활성 스레드로 되살린다. 현재 활성 대화는 먼저 보관(비파괴).
    sessionId(SDK 세션)까지 복원해 크루가 맥락을 이어서 답한다. 반환 = 되살린 스레드({sessionId, messages}). */
export async function resumeSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!new RegExp(`^${safe}-\\d+\\.json$`).test(id)) throw new Error('잘못된 세션 id');
  return withLock(lockKey(wsId, slug), async () => {
    const dir = join(paths(wsId).chats, '.archive');
    const restored = JSON.parse(await readFile(join(dir, id), 'utf8'));
    // 현재 활성 대화가 있으면 먼저 보관(유실 방지) — 새 타임스탬프로 적재
    const cur = await loadThread(wsId, slug);
    if (cur.messages?.length) {
      await writeJsonAtomic(join(dir, `${safe}-${Date.now()}.json`), cur);
    }
    // 보관본을 활성으로 되살리고, 원래 보관 파일은 제거(레일에 중복 노출 방지)
    await writeJsonAtomic(file(wsId, slug), restored);
    await rm(join(dir, id), { force: true });
    return restored;
  });
}

// ── 보관 세션 이름 편집 / 삭제(보관함으로) / 복구 ──
// 삭제는 하드 삭제가 아니라 chats/.trash/로 이동 — 설정 보관함에서 복구할 수 있다(비파괴).
const trashDir = (wsId) => join(paths(wsId).chats, '.trash');
const ARCH_ID = (safe) => new RegExp(`^${safe}-\\d+\\.json$`);
const ANY_ARCH_ID = /^[a-z0-9-]+-\d+\.json$/; // 보관함은 회사 전체(여러 크루) — id 앞부분이 slug

/** 현재(활성) 대화명 편집 — 활성 스레드 파일에 title 기록. '새 대화'로 적재되면 보관본에 그대로 승계된다
    (resetThread가 t 통째 보관 — 이름 붙인 대화가 레일에서도 그 이름으로 남는 것이 자연스러운 기대). */
export async function renameActiveThread(wsId, slug, title) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug);
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (clean) t.title = clean; else delete t.title;
    await writeJsonAtomic(file(wsId, slug), t);
    return { id: null, title: t.title ?? null };
  });
}

/** 대화명 편집 — 보관 세션 파일에 title을 기록(레일·보관함 표시는 title 우선, 없으면 gist). */
export async function renameSession(wsId, slug, id, title) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return withLock(lockKey(wsId, slug), async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const t = JSON.parse(await readFile(f, 'utf8'));
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (clean) t.title = clean; else delete t.title;
    await writeJsonAtomic(f, t);
    return { id, title: t.title ?? null };
  });
}

/** 세션 고정/해제 — 보관 세션 파일에 pinned를 기록(renameSession과 동일 in-file·원자적 쓰기 패턴).
    고정 세션은 레일 상단에 최근순으로 묶인다. resume로 아카이브가 사라지면 핀도 함께 사라진다(핀=보관 대화 표식). */
export async function setPinned(wsId, slug, id, pinned) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return withLock(lockKey(wsId, slug), async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const t = JSON.parse(await readFile(f, 'utf8'));
    if (pinned) t.pinned = true; else delete t.pinned;
    await writeJsonAtomic(f, t);
    return { id, pinned: t.pinned === true };
  });
}

/** 세션 삭제(보관) — .archive → .trash 이동. 레일에서 사라지고 설정 보관함에 나타난다(복구 가능). */
export async function trashSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return withLock(lockKey(wsId, slug), async () => {
    const from = join(paths(wsId).chats, '.archive', id);
    const data = JSON.parse(await readFile(from, 'utf8')); // 존재 검증 겸 읽기
    await mkdir(trashDir(wsId), { recursive: true });
    await writeJsonAtomic(join(trashDir(wsId), id), data);
    await rm(from, { force: true });
    return { id };
  });
}

/** 보관함 목록 — 회사 전체(모든 크루)의 삭제된 대화. 설정 보관함의 원천(최신순). */
export async function listTrashedSessions(wsId) {
  const dir = trashDir(wsId);
  let names = [];
  try { names = (await readdir(dir)).filter((n) => ANY_ARCH_ID.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(join(dir, n), 'utf8'));
      const m = n.match(/^([a-z0-9-]+)-(\d+)\.json$/);
      const firstUser = (t.messages ?? []).find((x) => x.who === 'user' && !x.shared && !x.via); // 레일 gist와 동일 규칙
      out.push({
        id: n, slug: m?.[1] ?? '', ts: Number(m?.[2] ?? 0),
        count: t.messages?.length ?? 0,
        title: t.title ?? null,
        gist: String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 항목 건너뜀 */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** 복구 — .trash → .archive (다시 크루 레일에 나타난다). id 앞부분이 slug라 원래 크루로 돌아간다. */
export async function restoreTrashed(wsId, id) {
  if (!ANY_ARCH_ID.test(id)) throw new Error('잘못된 세션 id');
  const from = join(trashDir(wsId), id);
  const to = join(paths(wsId).chats, '.archive', id);
  const data = JSON.parse(await readFile(from, 'utf8'));
  await mkdir(dirname(to), { recursive: true });
  await writeJsonAtomic(to, data);
  await rm(from, { force: true });
  return { id };
}

/** 영구 삭제 — 보관함에서 완전히 제거(복구 불가). */
export async function purgeTrashed(wsId, id) {
  if (!ANY_ARCH_ID.test(id)) throw new Error('잘못된 세션 id');
  await rm(join(trashDir(wsId), id), { force: true });
  return { id };
}
