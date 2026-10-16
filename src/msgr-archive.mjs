// 메신저 기록을 Argo(이 기기의 계정별 보관 폴더)로 옮기기(0.1.113, 2026-10-16 유건 결정 — 메신저 서비스 중단, Argo를 쓰는 사람은 메신저 데이터를 전부 Argo로).
// 서버 중단 스위치(msgr_service_pause, 워커 1)가 켜져 있고 이 계정의 이관 기록이 없으면 한 번만 받는다. 주기 호출은 없다 — 앱이 켜질 때 한 번, 설정 화면이 열릴 때 한 번 스위치를 읽는다.
//
// 무엇을: 로그인한 사용자가 메신저에서 볼 수 있던 것 전부 — 방(조직 채널·개인 1:1·친구 1:1·그룹·보관된 옛 조직 1:1), 방 정보·구성원 이름, 메시지(사람·에이전트·봇·시스템),
//   반응, 결재 카드(메시지 kind approval_card + 결재 행), 첨부(bucket msgr), 조직 문서(msgr_org_docs, journal/ 포함). 읽기는 기기 세션(사용자 JWT)으로만 — RLS가 원래 못 보던 것은 오지 않는다.
// 어디에: <WS_ROOT>/.msgr-archive/<uid 앞 8자>/ — 계정마다 하나, 회사 폴더 밖(검수 1 중간, 총괄 결정 2026-10-16). 방마다 messages.md(사람이 읽는 글)·messages.jsonl(원본 행)·room.json·attachments/.
//   회사 폴더(<WS_ROOT>/<회사>)는 크루 작업 폴더(cwd)라, 게이트를 거치지 않는 CLI 러너나 이름 없는 재귀 명령(grep -rn .·tar .)이 읽을 수 있었다. 회사 밖에 두면
//   ① 크루 작업 폴더·회사 동기화(회사 루트 walk)·회사 내보내기·클라우드 내보내기(점 이름 제외)에 들지 않고 ② 파일 도구는 WS_ROOT 직속 점 항목 규칙으로, 셸은 WS_DOT_FILES 이름으로 막고
//   ③ 기억 색인(회사 vault) 밖이다. 다른 사람의 글·AI 사용 동의를 거부한 사람의 글이 에이전트가 쓰는 기억에 섞이지 않는다(기술적으로 절대 못 읽는다는 약속은 하지 않는다 — 전권 CLI 러너는 경로를 알면 읽을 수 있다).
//   회사를 보관·이름 변경해도 위치가 바뀌지 않는다(계정 기준). 등록부 <WS_ROOT>/.msgr-archive.json은 어느 회사 화면에서 처음 받았는지(회사 id)만 적는다.
// 동기화하지 않는다: 메신저 첨부는 크고(동기화 50MB 상한 밖일 수 있다) 기기마다 서버에서 한 번 받으면 끝이라, 동기화 저장소·전송량을 늘릴 이유가 없다. 무료·Pro가 같은 동작이 된다.
// 이어 받기: 방마다 messages.jsonl 마지막 id가 커서다(상태 파일과 큰 쪽) — 중단·재시작 뒤 그 뒤부터 받고, 같은 메시지를 두 번 쓰지 않는다. 첨부는 같은 크기 파일이 있으면 다시 받지 않는다.
// 요청 상한: 페이지 1000행·id 묶음 200개·순차 요청. 429·5xx·네트워크 오류는 1·2·4·8초 백오프 4번 뒤 실패(상태 'failed' — 재시도 단추가 이어 받는다). 4xx(권한)는 그 항목만 건너뛴다.
import { mkdir, readFile, writeFile, appendFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './jsonstore.mjs';

export const PAUSE_RPC = 'msgr_service_pause';
export const ARCHIVE_DIR = '.msgr-archive'; // <WS_ROOT> 직속 — 계정별 하위 폴더
export const PAGE = 1000;
export const ID_BATCH = 200;
export const BACKOFF_MS = [1000, 2000, 4000, 8000];
export const PAUSE_TTL_MS = 10 * 60_000; // 설정 화면을 여러 번 열어도 10분에 한 번만 스위치를 읽는다
export const PAUSE_ERROR_TTL_MS = 60_000; // 읽기 실패(오프라인·옛 서버)는 1분 — 화면을 다시 열면 곧 다시 읽되 연달아 묻지는 않는다
const STATE = '_state.json';
const MSG_COLS = 'id, channel_id, org_id, author_kind, author_user_id, crew_id, kind, body, meta, mentions, reply_to, thread_root, created_at, edited_at';

/** 중단 스위치 판정 한 곳(워커 1 계약): RPC가 { paused: true, since } 를 주면 켜짐, null·오류·옛 서버(함수 없음)는 꺼짐. */
export const msgrShutdownOn = (data) => data?.paused === true;

/** 스위치 읽기 — 오류는 꺼짐으로 보고(지금과 같은 동작), 기록은 하지 않는다(다음 앱 시작·설정 열기에서 다시 읽는다). */
export async function readPause(client) {
  try {
    const { data, error } = await client.rpc(PAUSE_RPC);
    if (error) return { paused: false, since: null, error: error.code || error.message || 'error' };
    return { paused: msgrShutdownOn(data), since: msgrShutdownOn(data) ? (data.since ?? null) : null, error: null };
  } catch (e) { return { paused: false, since: null, error: e?.message ?? 'network' }; }
}

/** 스위치 값 캐시(프로세스 하나 — globalThis라 Next 번들 사본이 갈려도 하나). 이관 확인과 '메신저 받기' 단추가 같은 값을 쓴다(새 주기 호출 없음). */
const PAUSE = (globalThis.__argoMsgrPause ??= { value: null, at: 0 });
export async function pauseState(client, { now = Date.now, force = false } = {}) {
  if (!force && PAUSE.value && now() - PAUSE.at < (PAUSE.value.error ? PAUSE_ERROR_TTL_MS : PAUSE_TTL_MS)) return PAUSE.value;
  const v = await readPause(client);
  PAUSE.value = v; PAUSE.at = now();
  return v;
}
export const cachedPause = () => PAUSE.value;
export function _resetPauseCache() { PAUSE.value = null; PAUSE.at = 0; }

/** 계정마다 보관 폴더 하나 — <WS_ROOT>/.msgr-archive/<uid 앞 8자>. 앞 8자가 겹치는 다른 계정이 이미 쓰고 있으면 uid 전체로(두 계정 기록을 섞지 않는다). */
export async function archiveDirFor(wsRoot, uid) {
  const base = join(wsRoot, ARCHIVE_DIR, String(uid).slice(0, 8));
  const st = await readJsonSafe(join(base, STATE));
  if (!st || st.uid === uid) return base;
  return join(wsRoot, ARCHIVE_DIR, String(uid));
}

/** 어느 회사에 옮길까 — 이 계정이 주인인 회사만(남의 회사 폴더에 내 메신저 기록을 두지 않는다), 메신저가 켜진 회사 먼저, 그다음 가장 먼저 만든 회사. */
export function pickCompany(companies, uid) {
  const mine = (companies ?? []).filter((c) => c?.id && c.ownerId === uid);
  if (!mine.length) return null;
  const sorted = [...mine].sort((a, b) => (Number(!!b.msgr?.enabled) - Number(!!a.msgr?.enabled)) || String(a.created ?? '').localeCompare(String(b.created ?? '')));
  return sorted[0].id;
}

export async function readArchiveState(dir) { return readJsonSafe(join(dir, STATE)); }

async function readJsonSafe(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (status, error) => status === 0 || status === 429 || status >= 500 || (!status && !!error);

/** 인증 오류(토큰 만료·무효) — 받는 도중 기기 세션 토큰이 바뀌면 서버가 401(PostgREST)·400 'jwt expired'(Storage)를 준다. 이것을 '권한 없음'으로 읽고
    건너뛰면 메시지가 빠진 채 끝남으로 굳는다(#분리 검수 높음-1). 새 토큰으로 한 번 다시 묻고, 그래도면 실행 전체를 실패로 남긴다(다음 실행이 이어 받는다). */
const isAuthError = (status, error) => status === 401 || /jwt|JWT|PGRST30[1-3]|invalid.?token|token.*expired|Unauthorized/i.test(`${error?.code ?? ''} ${error?.message ?? ''} ${error?.error ?? ''}`);
const fail = (code, error) => Object.assign(new Error(`${code}: ${error?.message ?? error?.code ?? 'error'}`), { code });

/** 요청 하나를 백오프로 감싼다. fn(c) — c = 지금 쓸 클라이언트(토큰을 새로 받으면 바뀐다). 반환 { data, error }.
    soft = 재시도할 수 없는 오류(권한 등)를 돌려준다(호출부가 그 항목만 건너뛴다). soft가 아니면 그런 오류도 실행 전체 실패 — 빈 목록으로 읽고 '끝남'으로 굳히지 않는다.
    재시도할 수 있는 오류(429·5xx·네트워크)는 백오프 뒤 다 쓰면 실패. 인증 오류는 새 토큰으로 한 번 더, 그래도면 실패. */
async function call(ctx, fn, { soft = false } = {}) {
  let refreshed = false;
  for (let i = 0; ; i++) {
    let r;
    // supabase-js 내장 재시도(503·520 GET 3회)는 끈다 — 재시도·상한은 여기 한 곳(겹치면 요청이 4배)
    try { const b = fn(ctx.c); if (typeof b?.retry === 'function') b.retry(false); r = await b; } catch (e) { r = { data: null, error: { message: e?.message ?? String(e) }, status: 0 }; }
    ctx.stats.requests++;
    if (!r.error) { ctx.stats.bytes += approxBytes(r.data); return r; }
    const status = r.status ?? 0;
    if (isAuthError(status, r.error)) {
      if (!refreshed && ctx.refresh) { refreshed = true; ctx.c = (await ctx.refresh().catch(() => null)) ?? ctx.c; i--; continue; }
      throw fail('msgr_archive_auth', r.error);
    }
    if (retryable(status, r.error)) {
      if (i >= BACKOFF_MS.length) throw fail('msgr_archive_upstream', r.error);
      await ctx.sleep(BACKOFF_MS[i]);
      continue;
    }
    if (soft) return r;
    throw fail('msgr_archive_upstream', r.error);
  }
}
const approxBytes = (d) => { if (d == null) return 0; if (Buffer.isBuffer(d)) return d.length; if (typeof d?.size === 'number') return d.size; try { return Buffer.byteLength(JSON.stringify(d)); } catch { return 0; } };

/** 키셋 페이지 읽기 — 빈 페이지에서 멈춘다(서버 최대 행 수가 페이지를 조용히 자를 수 있어 짧은 페이지로 끝을 판정하지 않는다). key = 정렬·커서 열. */
async function pages(ctx, build, key, { soft = false } = {}) {
  const after = null;
  const out = [];
  for (let cursor = after; ;) {
    const c = cursor; // 시도마다 빌더를 새로 만든다(같은 빌더를 다시 쓰면 order가 겹쳐 붙는다)
    const { data, error } = await call(ctx, (cl) => { let q = build(cl); if (c != null) q = q.gt(key, c); return q.order(key, { ascending: true }).limit(PAGE); }, { soft });
    if (error) return { rows: out, error };
    if (!data?.length) return { rows: out, error: null };
    out.push(...data);
    cursor = data[data.length - 1][key];
  }
}
const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** 파일·폴더 이름 — 글자·숫자·공백·._- 만, 40자, 비면 '_'. */
export function safeName(s, max = 40) {
  const v = String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[.\s]+|\s+$/g, '').slice(0, max);
  return v || '_';
}
export function roomKind(ch) {
  if (ch.kind !== 'dm') return ch.kind === 'private' ? 'private' : 'public';
  if (ch.org_id) return ch.archived_at ? 'orgDmArchived' : 'orgDm';
  if (String(ch.personal_pair ?? '').startsWith('crew:')) return 'agentDm';
  return ch.personal_pair ? 'friendDm' : 'group';
}
const KIND_LABEL = { public: '조직 채널 · Org channel', private: '비공개 채널 · Private channel', orgDm: '조직 1:1 · Org 1:1', orgDmArchived: '보관된 조직 1:1 · Archived org 1:1', agentDm: '에이전트 1:1 · Agent 1:1', friendDm: '친구 1:1 · Friend 1:1', group: '그룹 · Group' };

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeOf = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 방 하나의 사람이 읽는 Markdown — 날짜 머리, 작성자 · 시각, 본문, 첨부·반응·결재. 원본은 messages.jsonl. */
export function renderRoomMarkdown(room, lines) {
  const out = [`# ${room.title}`, '', `- ${KIND_LABEL[room.kind] ?? room.kind}${room.orgName ? ` · ${room.orgName}` : ''}`];
  if (room.members?.length) out.push(`- 구성원 · Members: ${room.members.map((m) => m.name).join(', ')}`);
  out.push(`- 옮긴 시각 · Archived at: ${room.archivedAt}`, '');
  let day = '';
  for (const m of lines) {
    const d = dayOf(m.created_at);
    if (d !== day) { day = d; out.push(`## ${d}`, ''); }
    out.push(`**${m.author}** · ${timeOf(m.created_at)}${m.edited_at ? ' (수정됨 · edited)' : ''}`);
    if (m.body) out.push(m.body);
    if (m.kind === 'approval_card' && m.approval) out.push(`> 결재 · Approval: ${m.approval.action ?? ''} — ${m.approval.status ?? ''}${m.approval.reason ? ` (${m.approval.reason})` : ''}`);
    for (const a of m.attachments ?? []) out.push(a.file ? `> 첨부 · Attachment: [${a.name}](${encodeURI(a.file)})` : `> 첨부 · Attachment: ${a.name} (받지 못함 · not downloaded)`);
    if (m.reactions?.length) {
      const n = new Map(); for (const r of m.reactions) n.set(r.emoji, (n.get(r.emoji) ?? 0) + 1);
      out.push(`> 반응 · Reactions: ${[...n].map(([e, c]) => `${e} ${c}`).join(' · ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** jsonl 꼬리 — { id: 마지막 온전한 줄의 id, open: 파일이 줄바꿈 없이 끝남(반쯤 쓴 줄) }. 열린 채면 다음 덧붙이기를 줄바꿈으로 시작한다(반쪽 줄에 붙어 첫 줄이 깨지지 않게, 검수 낮음-5). */
async function jsonlTail(file) {
  let raw; try { raw = await readFile(file, 'utf8'); } catch { return { id: null, open: false }; }
  const open = raw.length > 0 && !raw.endsWith('\n');
  const rows = raw.split('\n').filter(Boolean);
  for (let i = rows.length - 1; i >= 0; i--) { try { return { id: JSON.parse(rows[i]).id ?? null, open }; } catch { /* 반쯤 쓴 줄 — 앞 줄을 본다 */ } }
  return { id: null, open };
}
async function readJsonl(file) {
  let raw; try { raw = await readFile(file, 'utf8'); } catch { return []; }
  const out = []; const seen = new Set();
  for (const l of raw.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } } catch { /* 반쯤 쓴 줄 */ } }
  return out;
}
async function sameSizeExists(file, bytes) { try { const s = await stat(file); return bytes == null ? s.size > 0 : s.size === Number(bytes); } catch { return false; } }

/**
 * 한 계정의 메신저 기록을 dir로 받는다. 이미 끝났으면(상태 done) 요청 0번으로 돌아온다.
 * client = 사용자 세션 supabase-js · uid = 그 계정 · onProgress(state) = 페이지마다 · sleep = 백오프(시험이 바꾼다).
 * 반환 상태 { status: 'done'|'partial'|'failed', rooms, messages, attachments, failed: [...], stats: { requests, bytes } }
 */
export async function runArchive({ client, getClient = null, uid, dir, onProgress = () => {}, sleep = sleepReal, now = () => new Date() }) {
  await mkdir(dir, { recursive: true });
  const prev = await readArchiveState(dir);
  if (prev?.status === 'done' && prev.uid === uid) return prev;
  const ctx = { stats: { requests: 0, bytes: 0 }, sleep, c: client ?? (getClient ? await getClient() : null), refresh: getClient };
  const st = {
    v: 1, uid, startedAt: prev?.startedAt ?? now().toISOString(), finishedAt: null, status: 'running', error: null,
    rooms: prev?.rooms ?? {}, docs: prev?.docs ?? {}, failed: [], totals: { rooms: 0, roomsDone: 0, messages: prev?.totals?.messages ?? 0, attachments: prev?.totals?.attachments ?? 0 },
    people: prev?.people ?? {}, crews: prev?.crews ?? {}, stats: ctx.stats,
  };
  const retryFailed = prev?.failed ?? [];
  const save = async () => { await writeJsonAtomic(join(dir, STATE), st); onProgress(st); };
  try {
    // 0) 지난 실행에서 못 받은 첨부부터
    for (const f of retryFailed) {
      if (await sameSizeExists(join(dir, f.file), f.bytes)) continue;
      const ok = await download(ctx, f.storage_path, join(dir, f.file));
      if (ok) st.totals.attachments++; else st.failed.push(f);
    }
    // 1) 조직 이름
    const orgs = await pages(ctx, (cl) => cl.from('msgr_orgs').select('id, name'), 'id');
    const orgName = new Map((orgs.rows ?? []).map((o) => [o.id, o.name]));
    // 2) 방 목록 — RLS가 이 계정이 읽을 수 있는 방만 준다(보관된 방 포함)
    const chs = await pages(ctx, (cl) => cl.from('msgr_channels').select('id, org_id, kind, name, topic, personal_pair, created_at, archived_at'), 'id');
    if (chs.error) throw Object.assign(new Error(`msgr_archive_rooms: ${chs.error.message ?? chs.error.code}`), { code: 'msgr_archive_upstream' });
    st.totals.rooms = chs.rows.length;
    st.totals.roomsDone = chs.rows.filter((c) => st.rooms[c.id]?.done).length;
    await save();
    for (const ch of chs.rows) {
      if (st.rooms[ch.id]?.done) continue;
      await archiveRoom(ctx, dir, ch, orgName, st, save, now);
      st.totals.roomsDone++;
      await save();
    }
    // 3) 조직 문서(journal/ 포함) — 조직마다, 권한 밖이면 서버가 빈 목록을 준다
    for (const [orgId, name] of orgName) {
      if (st.docs[orgId]) continue;
      const docs = await pages(ctx, (cl) => cl.from('msgr_org_docs').select('id, org_id, channel_id, path, title, body, version, updated_at, updated_by').eq('org_id', orgId), 'id');
      if (!docs.error && docs.rows.length) {
        const base = join(dir, 'docs', `${safeName(name)}-${String(orgId).slice(0, 8)}`);
        for (const d of docs.rows) {
          const rel = String(d.path ?? '').split('/').map((p) => safeName(p, 80)).join('/');
          const file = join(base, d.channel_id ? `channel-${String(d.channel_id).slice(0, 8)}` : '', rel || `${d.id}.md`);
          await mkdir(join(file, '..'), { recursive: true });
          await writeFile(file, `# ${d.title ?? ''}\n\n${d.body ?? ''}\n`);
        }
        await writeJsonAtomic(join(base, 'docs.json'), docs.rows);
      }
      st.docs[orgId] = true;
      await save();
    }
    st.status = st.failed.length ? 'partial' : 'done';
    st.finishedAt = now().toISOString();
    await writeReadme(dir, st, chs.rows);
  } catch (e) {
    st.status = 'failed'; st.error = e?.code ?? 'msgr_archive_failed';
    st.failed = [...st.failed, ...retryFailed.filter((f) => !st.failed.includes(f))];
  }
  await save();
  return st;
}

export const ATTACH_DOWN_AFTER = 3; // 첨부가 서버 오류(재시도까지 실패)로 연달아 이만큼 실패하면 이번 실행의 남은 첨부는 요청 없이 '못 받음'으로 남긴다(다시 받기가 받는다)
async function download(ctx, path, file) {
  if ((ctx.attachDown ?? 0) >= ATTACH_DOWN_AFTER) return false;
  let exhausted = false;
  const r = await call(ctx, async (cl) => { const x = await cl.storage.from('msgr').download(path); return x.error ? { data: null, error: x.error, status: x.error.status ?? x.error.statusCode ?? 400 } : { data: Buffer.from(await x.data.arrayBuffer()), error: null }; },
    { soft: true }).catch((e) => { if (e?.code === 'msgr_archive_auth') throw e; exhausted = true; return { error: true }; }); // 인증 오류는 첨부 실패가 아니라 실행 실패
  ctx.attachDown = exhausted ? (ctx.attachDown ?? 0) + 1 : 0;
  if (r.error) return false;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, r.data);
  return true;
}

async function archiveRoom(ctx, dir, ch, orgName, st, save, now) {
  const title = ch.name || (ch.kind === 'dm' ? 'DM' : ch.id);
  const roomDir = join(dir, 'rooms', `${safeName(title)}-${String(ch.id).slice(0, 8)}`);
  await mkdir(roomDir, { recursive: true });
  const jsonl = join(roomDir, 'messages.jsonl');
  const rs = (st.rooms[ch.id] ??= { dir: roomDir.slice(dir.length + 1), lastId: null, done: false });
  // 커서 = 상태 파일과 jsonl 마지막 줄 중 큰 쪽 — 줄을 쓴 뒤 상태를 저장하기 전에 멈춰도 같은 줄을 두 번 쓰지 않는다
  const { id: tail, open: tailOpen } = await jsonlTail(jsonl);
  let lead = tailOpen ? '\n' : '';
  let cursor = [rs.lastId, tail].filter((x) => x != null).map(Number).reduce((a, b) => Math.max(a, b), -Infinity);
  if (!Number.isFinite(cursor)) cursor = null;
  for (;;) {
    const c = cursor;
    const { data: page, error } = await call(ctx, (cl) => {
      let q = cl.from('msgr_messages').select(MSG_COLS).eq('channel_id', ch.id).is('deleted_at', null);
      if (c != null) q = q.gt('id', c);
      return q.order('id', { ascending: true }).limit(PAGE);
    }, { soft: true }); // 권한 거부(4xx, 인증 오류 아님)인 방만 받은 데까지
    if (error || !page?.length) break; // 권한 없는 방(4xx)은 받은 데까지
    const ids = page.map((m) => m.id);
    const reactions = new Map(); const atts = new Map(); const approvals = new Map();
    for (const part of chunks(ids, ID_BATCH)) {
      const r = await call(ctx, (cl) => cl.from('msgr_reactions').select('message_id, user_id, emoji, created_at').in('message_id', part));
      for (const x of r.data ?? []) (reactions.get(x.message_id) ?? reactions.set(x.message_id, []).get(x.message_id)).push(x);
      const a = await call(ctx, (cl) => cl.from('msgr_attachments').select('message_id, storage_path, name, mime, bytes').in('message_id', part));
      for (const x of a.data ?? []) (atts.get(x.message_id) ?? atts.set(x.message_id, []).get(x.message_id)).push(x);
      if (page.some((m) => part.includes(m.id) && m.kind === 'approval_card')) {
        const p = await call(ctx, (cl) => cl.from('msgr_crew_approvals').select('message_id, approval_id, action, reason, status, decided_by, decided_at').in('message_id', part), { soft: true }); // 결재 행을 못 읽으면 카드 본문만(메시지는 남는다)
        for (const x of p.data ?? []) approvals.set(x.message_id, x);
      }
    }
    const lines = [];
    for (const m of page) {
      const files = [];
      const used = new Set();
      for (const a of atts.get(m.id) ?? []) {
        // 한 메시지에 이름이 같은 첨부가 둘이면(붙여넣은 스크린샷 image.png 두 장) 순번을 붙인다 — 덮이면 앞의 것이 사라진다(분리 검수 중간-2)
        let base = safeName(a.name, 80); for (let n = 2; used.has(base); n++) base = `${n}-${safeName(a.name, 78)}`;
        used.add(base);
        const file = `attachments/${m.id}-${base}`;
        const abs = join(roomDir, file);
        let ok = await sameSizeExists(abs, a.bytes);
        if (!ok) ok = await download(ctx, a.storage_path, abs);
        if (ok) st.totals.attachments++;
        else st.failed.push({ storage_path: a.storage_path, file: `${rs.dir}/${file}`, bytes: a.bytes ?? null });
        files.push({ name: a.name, mime: a.mime, bytes: a.bytes, storage_path: a.storage_path, file: ok ? file : null });
      }
      lines.push(JSON.stringify({ ...m, reactions: reactions.get(m.id) ?? [], attachments: files, approval: approvals.get(m.id) ?? null }));
    }
    await appendFile(jsonl, `${lead}${lines.join('\n')}\n`); lead = '';
    cursor = ids[ids.length - 1];
    rs.lastId = cursor;
    st.totals.messages += page.length;
    await save();
  }
  // 구성원·이름 — 방 정보와 Markdown에 쓴다
  const mem = await pages(ctx, (cl) => cl.from('msgr_channel_members').select('channel_id, member_kind, member_id').eq('channel_id', ch.id), 'member_id', { soft: true }); // 구성원·이름은 표시용 — 못 읽어도 메시지는 남긴다
  const rows = await readJsonl(jsonl);
  const userIds = new Set([...(mem.rows ?? []).filter((m) => m.member_kind === 'user').map((m) => m.member_id), ...rows.map((m) => m.author_user_id).filter(Boolean), ...rows.flatMap((m) => (m.reactions ?? []).map((r) => r.user_id))]);
  const crewIds = new Set([...(mem.rows ?? []).filter((m) => m.member_kind === 'crew').map((m) => m.member_id), ...rows.map((m) => m.crew_id).filter(Boolean)]);
  const needU = [...userIds].filter((id) => !(id in st.people));
  for (const part of chunks(needU, ID_BATCH)) {
    const r = await call(ctx, (cl) => cl.rpc('msgr_people_names', { ids: part }), { soft: true });
    for (const x of r.data ?? []) st.people[x.user_id] = x.name;
    for (const id of part) st.people[id] ??= null; // 이름을 못 받은 사람(나간 사람 등)도 다시 묻지 않는다
  }
  const needC = [...crewIds].filter((id) => !(id in st.crews));
  for (const part of chunks(needC, ID_BATCH)) {
    const r = await call(ctx, (cl) => cl.from('msgr_crews').select('id, display_name').in('id', part), { soft: true });
    for (const x of r.data ?? []) st.crews[x.id] = x.display_name;
    for (const id of part) st.crews[id] ??= null;
  }
  const userName = (id) => st.people[id] || (id ? `user-${String(id).slice(0, 8)}` : '(탈퇴한 사용자 · deleted user)');
  const crewName = (id) => st.crews[id] || `agent-${String(id ?? '').slice(0, 8)}`;
  const members = (mem.rows ?? []).map((m) => ({ kind: m.member_kind, id: m.member_id, name: m.member_kind === 'user' ? userName(m.member_id) : crewName(m.member_id) }));
  const room = { id: ch.id, title, kind: roomKind(ch), orgId: ch.org_id, orgName: ch.org_id ? orgName.get(ch.org_id) ?? null : null, topic: ch.topic ?? null, created_at: ch.created_at, archived_at: ch.archived_at, members, archivedAt: now().toISOString() };
  await writeJsonAtomic(join(roomDir, 'room.json'), room);
  const author = (m) => (m.author_kind === 'user' ? userName(m.author_user_id) : m.author_kind === 'crew' ? crewName(m.crew_id) : '시스템 · System');
  await writeFile(join(roomDir, 'messages.md'), renderRoomMarkdown(room, rows.map((m) => ({ ...m, author: author(m) }))));
  rs.done = true;
}

async function writeReadme(dir, st, chs) {
  const rooms = Object.values(st.rooms).filter((r) => r.done).map((r) => r.dir).sort();
  const body = [
    '# 메신저 기록 · Messenger archive', '',
    '메신저에서 볼 수 있던 대화를 복사해 둔 읽기 전용 보관 폴더입니다. 에이전트 작업 폴더 밖에 따로 보관해 에이전트가 쓰는 기억과 섞이지 않고, 기기 사이에 동기화되지 않습니다.',
    "A read-only copy of the conversations you could see in Argo Messenger. It is kept outside the agents' working folders so it doesn't mix with the memory agents use, and it is not synced between devices.", '',
    `- 방 · Rooms: ${chs.length}`, `- 메시지 · Messages: ${st.totals.messages}`, `- 첨부 · Attachments: ${st.totals.attachments}`, '',
    ...rooms.map((r) => `- [${r}](${encodeURI(`${r}/messages.md`)})`), '',
  ].join('\n');
  await writeFile(join(dir, 'README.md'), body);
}

/** 보관 폴더 안 방 수(설정 화면 표시용) — 상태 파일이 없을 때의 보조. */
export async function countRooms(dir) { try { return (await readdir(join(dir, 'rooms'))).length; } catch { return 0; } }
