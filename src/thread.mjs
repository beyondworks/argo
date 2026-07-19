// 채팅 스레드 영속화 — 크루별 chats/<slug>.json 에 대화·세션을 남긴다.
// 새로고침해도 대화가 이어지는 것이 제품의 기본 자세다.
import { readFile, rm, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { paths, getDeviceId } from './workspace.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${slug.replace(/[^a-z0-9-]/g, '')}.json`);
// 같은 크루 스레드의 read-modify-write를 직렬화 — 웹·텔레그램 동시 턴의 lost-update 방지
const lockKey = (wsId, slug) => `thread:${wsId}:${slug.replace(/[^a-z0-9-]/g, '')}`;

export async function loadThread(wsId, slug) {
  // 대화는 유실이 치명적 — 손상 시 조용히 빈 상태로 리셋하지 않고 throw로 드러낸다(readJson).
  return readJson(file(wsId, slug), { sessionId: null, messages: [] });
}

export async function appendTurn(wsId, slug, { userMsg, reply, handover, sessionId, attachments }) {
  return withLock(lockKey(wsId, slug), async () => {
    const t = await loadThread(wsId, slug); // 락 안에서 최신 상태를 다시 읽는다
    const ts = Date.now();
    t.messages.push(
      { who: 'user', text: userMsg, ts, ...(attachments?.length ? { attachments } : {}) },
      { who: 'crew', text: reply, handover, ts },
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
      const firstUser = (t.messages ?? []).find((m) => m.who === 'user' && !m.shared);
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
    await rm(file(wsId, slug), { force: true });
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
      const firstUser = (t.messages ?? []).find((x) => x.who === 'user' && !x.shared);
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
