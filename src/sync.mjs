// C-1 기기 간 동기화 — "회사 = 폴더" 하나가 진실의 원천이고, 이 엔진이 그 폴더를
// Supabase Storage에 복제해 어느 기기에서 켜도 같은 회사가 열리게 한다.
//
// 방식: 회사별 __manifest__.json(경로→mtime·size)을 기준으로 푸시/풀, 파일 단위 LWW.
// 삭제 전파는 로컬 .sync-state.json(마지막 동기화 시점의 매니페스트)과의 대조로 판별 —
// "내가 지운 것"과 "아직 안 받은 것"을 구분한다.
//
// 시크릿(connections.json·.secrets.json): 서비스 키가 있으면 봉투 암호화(secretbox)로 동기화 —
// 스토리지엔 암호문만 놓이고, 기기마다 재입력할 필요가 없다. 키 없는 환경은 기존대로 제외.
// 그 외 제외(동기화 금지): .gateway*·.gw-offset*(폴러 상태), *.status.json(턴 일시 상태),
// *.lock, .sync-state.json, .device-id.
//
// C-2 최소형: 오너별 _device-lease.json 클라우드 리스 — 두 기기가 동시에 켜져도
// 폴러·루틴 실행 주체는 한 기기만(게이트웨이·스케줄러가 isCloudLeader를 함께 본다).
//
// v1 한계(문서화): 서비스 키 기반(자가 호스팅 전제 — 패키징 앱은 사용자 JWT+RLS로 전환 예정),
// 충돌은 LWW(더 최근 mtime 승) — md 양쪽 보존은 후속.
import { mkdir, readFile, writeFile, readdir, stat, rm, utimes } from 'node:fs/promises';
import { join, dirname, basename, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT, paths } from './workspace.mjs';
import { writeJsonAtomic, writeFileAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { cryptoOn, isSecretRel, sealSecret, openSecret } from './secretbox.mjs';
import { loadSyncCreds, credsEpoch } from './synccreds.mjs';
import { loadDeviceSession, getFreshDeviceSession } from './devicesession.mjs';
import { ensureAccountKey } from './accountkey.mjs';
import { syncEntitled } from './entitlement.mjs';

const BUCKET = 'companies';
// 준실시간 — 기본 8s(웹↔앱 지연 단축). ARGO_SYNC_CYCLE_MS로 조정(비용/지연 트레이드오프).
const CYCLE_MS = Number(process.env.ARGO_SYNC_CYCLE_MS) || 8_000;
// 크로스 프로세스 락 스테일 판정 — CYCLE_MS와 분리한다. 주기 단축(45→8s)이 이중 동기화 방어막을
// 좁히면(느린 사이클의 살아있는 리더를 오탈취) 삭제 피드백 루프=대형 유실이 날 수 있다(리뷰 H1).
// 죽은 프로세스 락은 이 시간 내 회수하되, 살아있는 리더는 오탈취 안 되게 넉넉히.
const LOCK_STALE_MS = Math.max(CYCLE_MS * 3, 120_000);
const LEASE_TTL_MS = 120_000; // 이 시간 동안 갱신 없으면 다른 기기가 리더를 가져간다

// 동기화 스위치 — 서비스 자격(env/페어링 파일) 또는 기기 세션(로그인=연동). 서비스 자격이 우선.
export const syncOn = () => (!!loadSyncCreds() || !!loadDeviceSession()) && process.env.ARGO_SYNC !== '0';

const EXCLUDE = (rel) => {
  // 시크릿 — 봉투 암호화 가능하면 동기화(암호문으로만), 키 없으면 기존대로 제외(기기별 입력)
  if (isSecretRel(rel)) return !cryptoOn();
  const base = rel.split('/').pop();
  return (
    base.startsWith('.gateway') || base.startsWith('.gw-offset') ||
    base.startsWith('.gw-queue') || // 디스크 큐(지시 대기) — 로컬 처리 상태, 동기화 대상 아님
    base === '.sync-state.json' || base === '.device-id' || base === '.sync-credentials.json' ||
    base === '.device-session.json' || base === '.DS_Store' ||
    base.endsWith('.status.json') || base.endsWith('.lock') ||
    base.startsWith('.tmp-') || base.endsWith('.corrupt') || rel.includes('.corrupt-') // 원자쓰기 임시·손상 백업
  );
};

const CLIENT_OPTS = {
  auth: { persistSession: false },
  // 타임아웃 필수 — 기본 fetch는 무한 대기라 요청 하나가 걸리면 동기화 전체가 영원히 멈춘다(실측)
  global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) }) },
};
let sb = null, sbKey = '';
// cycle 시작마다 호출 — 서비스 모드는 epoch, 세션 모드는 access token으로 캐시 키를 삼아
// 자격 회전 시에만 클라이언트를 재생성한다. false = 쓸 자격 없음(이번 사이클 스킵).
async function ensureClient() {
  const svc = loadSyncCreds();
  if (svc) {
    const k = `svc:${credsEpoch()}`;
    if (sbKey !== k) { sb = createClient(svc.url, svc.key, CLIENT_OPTS); sbKey = k; }
    return true;
  }
  const sess = await getFreshDeviceSession();
  if (!sess) return false;
  const k = `sess:${sess.access_token.slice(-24)}`;
  if (sbKey !== k) {
    sb = createClient(sess.url, sess.anonKey, {
      ...CLIENT_OPTS,
      global: { ...CLIENT_OPTS.global, headers: { Authorization: `Bearer ${sess.access_token}` } },
    });
    sbKey = k;
  }
  return true;
}
const client = () => sb; // ensureClient() 성공 뒤에만 호출된다 (cycle/ensureSync 게이트)

// 스토리지 키 — 한글·특수문자 세그먼트는 base64url로(스토리지가 %·비ASCII 키를 거부, 실측).
// 매니페스트에 논리 경로를 담고 키는 항상 이 함수로 파생하므로 역디코딩은 불필요하다.
const encSeg = (s) => (/^[A-Za-z0-9._-]+$/.test(s) ? s : `u8-${Buffer.from(s).toString('base64url')}`);
const skey = (...segs) => segs.flatMap((s) => s.split('/')).map(encSeg).join('/');

/* ─── 기기 식별 ─── */
let deviceId = null;
async function getDeviceId() {
  if (deviceId) return deviceId;
  const f = join(WS_ROOT, '.device-id');
  try {
    deviceId = (await readFile(f, 'utf8')).trim();
  } catch {
    deviceId = `${hostname().split('.')[0]}-${randomUUID().slice(0, 8)}`;
    await mkdir(WS_ROOT, { recursive: true });
    await writeFile(f, deviceId);
  }
  return deviceId;
}

/* ─── 크로스 프로세스 단일 동기화 락 ───
   같은 데이터 루트에 두 서버가 뜨면(실수로 dev + 상주 동시 기동 등) 서로의 로컬·원격·.sync-state를
   두고 레이스하며 삭제 피드백 루프를 만든다(실측 대형 유실). 한 root당 한 프로세스만 동기화하도록
   pidfile로 막는다. .lock은 EXCLUDE라 동기화 대상 아님. */
async function holdSyncLock() {
  const f = join(WS_ROOT, '.sync-process.lock');
  try {
    const cur = JSON.parse(await readFile(f, 'utf8'));
    if (cur.pid !== process.pid && Date.now() - cur.ts < LOCK_STALE_MS) {
      try { process.kill(cur.pid, 0); return false; } catch { /* 죽은 pid → 탈취 */ }
    }
  } catch { /* 없음/손상 → 획득 */ }
  try { await mkdir(WS_ROOT, { recursive: true }); await writeFile(f, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* 쓰기 실패 시에도 진행 */ }
  return true;
}

/* ─── 클라우드 리스 (C-2 최소형) — 실행(폴러·루틴) 주체는 한 기기만 ───
   상태는 globalThis에 — Next가 라우트/instrumentation을 별도 번들로 복제해도 하나를 본다. */
const leaseState = (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0 }); // off면 항상 리더(단일 기기)
export function isCloudLeader() {
  return !syncOn() || leaseState.leader;
}

async function renewLease(owner) {
  const me = await getDeviceId();
  const key = skey(owner, '_device-lease.json');
  let cur = null;
  try {
    const { data } = await client().storage.from(BUCKET).download(key);
    if (data) cur = JSON.parse(Buffer.from(await data.arrayBuffer()).toString());
  } catch { /* 최초 */ }
  const fresh = cur && Date.now() - cur.ts < LEASE_TTL_MS;
  if (fresh && cur.deviceId !== me) {
    if (leaseState.leader) console.log(`[argo] 동기화: 실행 리더 양보 → ${cur.deviceId}`);
    leaseState.leader = false;
    leaseState.checkedAt = Date.now();
    return;
  }
  // 내 것이거나 만료 — 획득 시도. 스토리지엔 진짜 CAS가 없으므로 write-후-재확인으로
  // 이중 리더 창을 좁힌다: 내 토큰을 쓰고, 잠깐 뒤 다시 읽어 최종 승자가 나인지 확인.
  const token = randomUUID();
  await client().storage.from(BUCKET).upload(
    key, new Blob([JSON.stringify({ deviceId: me, token, ts: Date.now() })]),
    { upsert: true, contentType: 'application/json' },
  );
  await new Promise((r) => setTimeout(r, 800)); // 동시 기동한 다른 기기의 쓰기가 도착할 여유
  let winner = null;
  try {
    const { data } = await client().storage.from(BUCKET).download(`${key}?t=${Date.now()}`);
    if (data) winner = JSON.parse(Buffer.from(await data.arrayBuffer()).toString());
  } catch { /* 재확인 실패 — 보수적으로 팔로워 */ }
  const iWon = winner && winner.token === token; // 내가 마지막 승자여야만 리더
  if (iWon && !leaseState.leader) console.log(`[argo] 동기화: 실행 리더 획득 (${me})`);
  if (!iWon && leaseState.leader) console.log(`[argo] 동기화: 실행 리더 경합 양보 (${me})`);
  leaseState.leader = !!iWon;
  leaseState.checkedAt = Date.now();
}

/* ─── 로컬 스캔 (내용 해시 포함 — 변경 판별의 진실) ─── */
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
async function walk(dir, base = dir, out = {}, failed = null) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch {
    // 이 디렉터리를 못 읽음(EMFILE·EIO·권한·레이스 등) — 하위 파일들의 '부재'는 삭제가 아니라 unknown.
    // subtree prefix를 기록해 삭제 전파·브레이크 집계에서 제외한다(walk 실패발 대량/피드백 유실 차단).
    if (failed) failed.add(dir === base ? '' : dir.slice(base.length + 1).split(sep).join('/'));
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1).split(sep).join('/');
    if (e.isDirectory()) await walk(full, base, out, failed);
    else if (!EXCLUDE(rel)) {
      try {
        const buf = await readFile(full);
        const st = await stat(full).catch(() => null);
        out[rel] = { m: st ? Math.round(st.mtimeMs) : Date.now(), s: buf.length, h: hashBuf(buf) };
      } catch { /* 읽는 중 사라진 파일 — 스킵 */ }
    }
  }
  return out;
}

// 파일 종류 — 충돌 처리 전략이 갈린다. (export: 회귀 테스트용 순수 함수)
export const isLedger = (rel) => rel.endsWith('.jsonl'); // usage.jsonl, events.jsonl — append-only 원장(행 병합)
export const isText = (rel) => rel.endsWith('.md');       // 노트·일지 — 충돌 시 양쪽 보존
export const isThread = (rel) => /^chats\/[^/]+\.json$/.test(rel); // 진행 중 턴과 레이스 → 스레드 락
// 아카이브(.archive)·휴지통(.trash)은 content 삭제가 아니라 이동(비파괴) — 대량삭제 브레이크 집계에서 제외한다.
// 세션 여러 개 삭제(=.archive→.trash 이동)가 브레이크를 걸어 소규모 회사 동기화를 영구 정지시키던 문제 방지(리뷰 M2). 동기화 push/pull 자체는 정상 진행.
export const isArchival = (rel) => /(^|\/)\.(archive|trash)\//.test(rel);
/** walk가 readdir 실패로 못 읽은 subtree 안의 경로인가 — 이 경로의 로컬 '부재'는 삭제가 아니라 unknown이므로
    삭제 전파·브레이크 집계에서 제외한다. failed는 walk가 채운 실패 prefix 집합('' = 루트 전체). (export: 회귀 테스트용) */
export const isUnderFailed = (rel, failed) => {
  if (!failed || failed.size === 0) return false;
  for (const d of failed) if (d === '' || rel === d || rel.startsWith(`${d}/`)) return true;
  return false;
};
/** 이번 사이클에 새로 나타난 아카이브/휴지통 파일의 basename 집합(base에 없던 것) — .archive→.trash 이동의 '목적지'.
    이동의 삭제 쪽만 브레이크에서 제외하고, 짝 없는 순수 소멸(walk 실패·디스크 결함)은 삭제로 집계하기 위한 판별. (export: 회귀 테스트용) */
export const archivalCreateNames = (local, state) => {
  const s = new Set();
  for (const rel of Object.keys(local)) if (isArchival(rel) && !state[rel]) s.add(rel.split('/').pop());
  return s;
};
/** 대량 삭제 브레이크 — 삭제 예정 수가 위험하면 true(중단). 회사 파일을 통째로 지우거나(전부 삭제)
   큰 배치(8개↑ 또는 절반↑)면 중단. 삭제는 비가역이라 "안 지우고 보류"가 항상 옳다. (export: 회귀 테스트용) */
export const massDeleteBrake = (deletes, baseCount) =>
  baseCount >= 2 && (deletes >= baseCount || deletes >= Math.max(8, Math.ceil(baseCount * 0.5)));
/** 안전한 상대 경로인가 — 원격 매니페스트 키를 FS에 join하기 전 검증(경로 탈출 차단, P1-7).
   원격 키는 신뢰할 수 없다(변조된 __manifest__.json이 `../../etc/x` 같은 키로 워크스페이스 밖 파일을
   쓰거나 지우게 할 수 있다). 절대경로·빈/`.`/`..` 세그먼트·NUL을 거부한다. (export: 회귀 테스트용) */
export const safeRel = (rel) =>
  typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\0')
  && !rel.includes('\\') && !/^[a-zA-Z]:/.test(rel) // Windows: 백슬래시·드라이브문자(C:) 거부(데스크톱/Electron 대비)
  && !rel.split('/').some((s) => s === '' || s === '.' || s === '..');
const threadLockKey = (wsId, rel) => `thread:${wsId}:${rel.slice(6).replace(/\.json$/, '').replace(/[^a-z0-9-]/g, '')}`;

/** 원장 병합 — 원격+로컬 행의 합집합(동일 행 dedup). 순서: 원격 먼저 후 로컬 신규. blob LWW의 행 유실 방지. */
export function mergeLedger(localBuf, remoteBuf) {
  const seen = new Set();
  const out = [];
  for (const buf of [remoteBuf, localBuf]) {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return Buffer.from(out.length ? out.join('\n') + '\n' : '');
}

/** 스레드 blob 충돌 병합 — 메시지 배열 합집합(ts|who|text로 dedup), ts 오름차순. 웹↔앱 동시 편집의 turn 유실 방지.
    prefer('remote'|'local') = title·sessionId 등 스칼라 필드를 취할 쪽(더 최근 mtime). 파싱 불가한 쪽은 반대쪽 채택. (export: 회귀 테스트용) */
export function mergeThread(localBuf, remoteBuf, prefer = 'remote') {
  const parse = (b) => { try { const o = JSON.parse(b.toString('utf8')); return o && Array.isArray(o.messages) ? o : null; } catch { return null; } };
  const L = parse(localBuf), R = parse(remoteBuf);
  if (!L && !R) return prefer === 'local' ? localBuf : remoteBuf; // 둘 다 파싱 불가 — blob 그대로(LWW 폴백)
  if (!L) return remoteBuf;
  if (!R) return localBuf;
  const seen = new Set();
  const msgs = [];
  for (const m of [...R.messages, ...L.messages]) {
    const k = `${m?.ts ?? ''}|${m?.who ?? ''}|${typeof m?.text === 'string' ? m.text : JSON.stringify(m?.text ?? '')}`;
    if (seen.has(k)) continue;
    seen.add(k); msgs.push(m);
  }
  msgs.sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0));
  const primary = prefer === 'local' ? L : R, other = prefer === 'local' ? R : L;
  const merged = { ...other, ...primary, messages: msgs };
  merged.sessionId = primary.sessionId ?? other.sessionId ?? null; // 이어가기 세션은 최근 편집 쪽으로 수렴
  return Buffer.from(JSON.stringify(merged, null, 2));
}

const stateFile = (wsId) => join(paths(wsId).root, '.sync-state.json');
const loadState = (wsId) => readJsonLenient(stateFile(wsId), { files: {} });

async function download(key) {
  const { data, error } = await client().storage.from(BUCKET).download(key);
  if (error) throw new Error(error.message);
  return Buffer.from(await data.arrayBuffer());
}

async function upload(key, buf) {
  const { error } = await client().storage.from(BUCKET).upload(
    key, new Blob([buf]), { upsert: true, contentType: 'application/octet-stream' },
  );
  if (error) throw new Error(error.message);
}

/* ─── 회사 1개 동기화 — base(마지막 동기화 상태) 대비 3-way 병합.
   "누가 바꿨나"를 해시로 판별해, 한쪽만 바뀌면 그쪽을 반영하고, 양쪽이 바뀌면 파일 종류별로
   충돌을 해소한다(원장=행 병합, 텍스트=양쪽 보존, 스레드=락). blind LWW로 조용히 파기하지 않는다. */
export async function syncCompany(wsId, owner) {
  const root = paths(wsId).root;
  const me = await getDeviceId();
  const manifestKey = skey(owner, wsId, '__manifest__.json');
  // 매니페스트 읽기 — "없음(최초 푸시)"과 "읽기 실패(네트워크·타임아웃·5xx)"를 반드시 구분한다.
  // 실패를 빈 원격으로 오인하면 base의 전 파일을 '원격에서 삭제됨'으로 판정해 로컬을 통째로 지운다(대형 유실 원인).
  let remote = { files: {} };
  {
    const { data, error } = await client().storage.from(BUCKET).download(manifestKey);
    if (error) {
      const msg = String(error.message || error);
      const notFound = /not[ _]?found|does not exist|no such|404/i.test(msg) || error.status === 404 || error.statusCode === 404;
      if (!notFound) throw new Error(`매니페스트 읽기 실패 — 삭제 보류(다음 사이클 재시도): ${msg.slice(0, 80)}`);
      // notFound = 원격 진짜 없음(최초 푸시). 이때 base(.sync-state)도 비어 삭제 분기가 안 타므로 안전.
    } else {
      try { remote = JSON.parse(Buffer.from(await data.arrayBuffer()).toString()); }
      catch (e) { throw new Error(`매니페스트 파싱 실패 — 삭제 보류: ${String(e.message).slice(0, 80)}`); }
    }
  }
  // 원격 매니페스트 키 위생(P1-7) — 변조된 키(경로 탈출 `../..`)를 FS 반영 전에 걸러낸다. 걸러진 키는 이 사이클 무시.
  if (remote.files && typeof remote.files === 'object') {
    let dropped = 0;
    for (const k of Object.keys(remote.files)) if (!safeRel(k)) { delete remote.files[k]; dropped++; }
    if (dropped) console.warn(`[sync] 안전하지 않은 원격 매니페스트 키 ${dropped}개 무시(경로 탈출 차단) — ws=${wsId}`);
  }
  const failedDirs = new Set();
  const local = await walk(root, root, {}, failedDirs);
  const state = (await loadState(wsId)).files ?? {};
  let pulled = 0, pushed = 0, deletedL = 0, deletedR = 0, merged = 0, conflicts = 0, failed = 0;

  const relFull = (rel) => {
    if (!safeRel(rel)) throw new Error(`안전하지 않은 동기화 키 차단(경로 탈출): ${String(rel).slice(0, 80)}`);
    return join(root, ...rel.split('/'));
  };
  const remoteKey = (rel) => skey(owner, wsId, rel);
  // 시크릿 봉투 — 밀 때 암호화, 받을 때 복호화. 스토리지엔 평문 크레덴셜이 절대 놓이지 않는다.
  // (복호화 실패 = 위변조/키 불일치 → throw → per-file catch가 failed로 집계, 다음 사이클 재시도)
  const pullBuf = async (rel) => { const b = await download(remoteKey(rel)); return isSecretRel(rel) ? openSecret(b) : b; };
  const pushBuf = async (rel) => { const b = await readFile(relFull(rel)); return isSecretRel(rel) ? sealSecret(b) : b; };
  // 로컬 쓰기 — 스레드 파일이면 진행 중 턴과 직렬화(레이스 방지). 원자쓰기(tmp→fsync→rename)로
  // 크래시 시 파일이 잘려 '손상→삭제 오전파'로 번지는 것을 차단(.tmp-는 EXCLUDE라 원격에 안 샌다).
  const writeLocal = async (rel, buf, mtime) => {
    const doWrite = async () => {
      const full = relFull(rel);
      // 복호화된 시크릿(.secrets.json·connections)이 신규 기기 복원 시 0644로 생기지 않게 0600 강제(P1-8).
      await writeFileAtomic(full, buf, isSecretRel(rel) ? { mode: 0o600 } : undefined);
      if (mtime) await utimes(full, new Date(mtime), new Date(mtime));
    };
    if (isThread(rel)) await withLock(threadLockKey(wsId, rel), doWrite);
    else await doWrite();
  };
  const rmLocal = async (rel) => {
    if (isThread(rel)) await withLock(threadLockKey(wsId, rel), () => rm(relFull(rel), { force: true }));
    else await rm(relFull(rel), { force: true });
  };
  // 로컬 파일이 사라졌지만 같은 자리에 .corrupt- 백업이 있으면 — 사용자 삭제가 아니라 로컬 손상(readJson이 치워둠).
  // 삭제 전파 대신 원격 정상본으로 self-heal 하고, 소비한 백업은 정리한다(잔존 시 이후 정당한 삭제를 손상으로 오인 — 재검수 지적).
  const corruptBackups = async (rel) => {
    try {
      const full = relFull(rel);
      const bn = basename(full);
      const dir = dirname(full);
      return (await readdir(dir)).filter((n) => n.startsWith(`${bn}.corrupt-`)).map((n) => join(dir, n));
    } catch { return []; }
  };
  const changed = (a, b) => !a || !b || (a.h ?? `${a.m}:${a.s}`) !== (b.h ?? `${b.m}:${b.s}`);

  const allRels = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(state)]);

  const archMoves = archivalCreateNames(local, state); // .archive→.trash 이동의 목적지 basename
  // 로컬 손상(readJson이 .corrupt-로 치워둠)으로 '부재'가 된 삭제 후보 — 삭제가 아니라 self-heal 대상.
  // 브레이크 집계와 전파가 동일하게 이 판정을 참조하도록 한 번만 계산(불일치 시 대량 동시손상이 sync를 멈춰 복구까지 막던 지적 반영).
  const corruptHeal = new Set(); // 로컬 손상으로 부재가 된 삭제 후보 rel — self-heal 대상(브레이크·전파 공통 참조)
  for (const rel of allRels) {
    const l = local[rel], r = remote.files[rel], base = state[rel];
    if (!l && r && base && !changed(base, r) && !isUnderFailed(rel, failedDirs) && (await corruptBackups(rel)).length) {
      corruptHeal.add(rel);
    }
  }
  // 삭제 판별 단일 출처 — 브레이크 집계와 실제 전파가 같은 규칙을 쓴다(불일치가 M2 회귀의 원인이었다).
  // side 'L'=로컬 삭제 예정, 'R'=원격 삭제 예정. walk 실패 subtree·로컬 손상·아카이브 '이동'(짝 있음)은 삭제가 아니다.
  const isRealDelete = (rel, l, r, base, side) => {
    if (isSecretRel(rel) && !cryptoOn()) return false;
    if (isUnderFailed(rel, failedDirs)) return false;                        // walk가 못 읽음 → 부재는 unknown
    if (corruptHeal.has(rel)) return false;                                   // 로컬 손상 → self-heal 대상(삭제 아님)
    if (isArchival(rel) && archMoves.has(rel.split('/').pop())) return false; // 진짜 이동(목적지 생성 있음)
    return side === 'L' ? !!(l && !r && base && !changed(base, l))
                        : !!(!l && r && base && !changed(base, r));
  };

  // 대량 삭제 브레이크 — 한 사이클이 회사 파일 대부분을 지우려 하면 중단(원격 오판·레이스·walk 실패 방어).
  // 삭제는 비가역이라 "보류"가 항상 안전. 의도된 대량 삭제만 env로 명시 허용.
  {
    const baseCount = Object.keys(state).length;
    let delL = 0, delR = 0;
    for (const rel of allRels) {
      const l = local[rel], r = remote.files[rel], base = state[rel];
      if (isRealDelete(rel, l, r, base, 'L')) delL++;
      if (isRealDelete(rel, l, r, base, 'R')) delR++;
    }
    if (process.env.ARGO_SYNC_ALLOW_MASS_DELETE !== '1' && (massDeleteBrake(delL, baseCount) || massDeleteBrake(delR, baseCount))) {
      throw new Error(`대량 삭제 감지(로컬 ${delL}·원격 ${delR} / base ${baseCount}) — 동기화 보류. 의도면 ARGO_SYNC_ALLOW_MASS_DELETE=1`);
    }
  }

  for (const rel of allRels) {
    if (isSecretRel(rel) && !cryptoOn()) continue; // 키 미확보 사이클 — 시크릿은 diff 자체에서 불가시(삭제 오인 차단)
    const l = local[rel], r = remote.files[rel], base = state[rel];
    const localChg = changed(base, l);   // base 대비 로컬 변경(생성/수정/삭제)
    const remoteChg = changed(base, r);   // base 대비 원격 변경
    try {
      // ── 삭제 전파 ──
      if (!l && r) { // 로컬에 없음
        if (isUnderFailed(rel, failedDirs)) continue; // walk가 subtree를 못 읽음 — 부재는 unknown(삭제 아님), 보류
        let revived = false;
        if (base && !remoteChg) { // 삭제로 보임 — 단 로컬 손상(.corrupt-)이면 삭제가 아니라 복구
          if (corruptHeal.has(rel)) { // 로컬 손상 → 원격 정상본을 받아 self-heal
            await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++; conflicts++; revived = true;
          } else { // 진짜 삭제 → 원격도 삭제
            await client().storage.from(BUCKET).remove([remoteKey(rel)]);
            delete remote.files[rel]; deletedR++;
          }
        } else if (!base) { // 원격 신규 → 받기
          await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++; revived = true;
        } else { // 내가 지웠지만 원격도 바뀜 = 충돌 → 원격 부활본을 받아 유실 방지
          await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++; conflicts++; revived = true;
        }
        // 원격에서 로컬을 복원한 경우 — 이 자리에 남아있던 손상 백업은 잉여. 어느 복원 경로(self-heal·신규·충돌복구)든
        // 청소해, 잔존 백업이 이후 정당한 삭제/리셋을 손상으로 오인해 되살리는 것을 막는다(재검수 잔여 지적).
        if (revived) for (const b of await corruptBackups(rel)) await rm(b, { force: true }).catch(() => {});
        continue;
      }
      if (l && !r) { // 원격에 없음
        if (base && !localChg) { await rmLocal(rel); delete local[rel]; deletedL++; } // 다른 기기가 지움 → 로컬도
        else { await upload(remoteKey(rel), await pushBuf(rel)); remote.files[rel] = l; pushed++; } // 신규/수정 → 밀기
        continue;
      }
      // ── 양쪽 존재 ──
      if (!localChg && !remoteChg) continue;      // 변경 없음
      if (remoteChg && !localChg) { // 원격만 변경 → 받기
        await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++; continue;
      }
      if (localChg && !remoteChg) { // 로컬만 변경 → 밀기
        await upload(remoteKey(rel), await pushBuf(rel)); remote.files[rel] = l; pushed++; continue;
      }
      // ── 양쪽 변경 = 충돌 ──
      if ((l.h ?? '') === (r.h ?? '')) { // 내용이 우연히 같아짐 → 상태만 정렬
        remote.files[rel] = l; continue;
      }
      const localBuf = await readFile(relFull(rel));
      const remoteBuf = await pullBuf(rel);
      if (isLedger(rel)) { // 원장 — 행 합집합 병합 후 양쪽 수렴
        const mBuf = mergeLedger(localBuf, remoteBuf);
        await writeLocal(rel, mBuf);
        await upload(remoteKey(rel), mBuf);
        local[rel] = { m: Date.now(), s: mBuf.length, h: hashBuf(mBuf) };
        remote.files[rel] = local[rel]; merged++;
      } else if (isThread(rel)) { // 스레드 blob — 메시지 배열 union 병합(양쪽 turn 보존), 스칼라는 최근 편집 쪽
        const mBuf = mergeThread(localBuf, remoteBuf, (r.m ?? 0) >= (l.m ?? 0) ? 'remote' : 'local');
        await writeLocal(rel, mBuf);
        await upload(remoteKey(rel), mBuf);
        local[rel] = { m: Date.now(), s: mBuf.length, h: hashBuf(mBuf) };
        remote.files[rel] = local[rel]; merged++;
      } else if (isText(rel)) { // 텍스트 — 원격을 정본으로 받고, 로컬본은 .conflict로 보존(양쪽 유실 없음)
        const cRel = rel.replace(/\.md$/, `.conflict-${me}-${Date.now()}.md`);
        await writeLocal(cRel, localBuf);
        await upload(remoteKey(cRel), localBuf);
        await writeLocal(rel, remoteBuf, r.m);
        local[rel] = r; local[cRel] = { m: Date.now(), s: localBuf.length, h: hashBuf(localBuf) };
        remote.files[cRel] = local[cRel]; pulled++; conflicts++;
      } else { // 기타(json 등) — 최근 mtime 승(LWW), 단 카운트해 관측 가능하게
        if ((r.m ?? 0) >= (l.m ?? 0)) { await writeLocal(rel, remoteBuf, r.m); local[rel] = r; pulled++; }
        else { await upload(remoteKey(rel), isSecretRel(rel) ? sealSecret(localBuf) : localBuf); remote.files[rel] = l; pushed++; }
        conflicts++;
      }
    } catch { failed++; } // 파일 하나 실패는 다음 사이클이 재시도
  }

  await upload(manifestKey, Buffer.from(JSON.stringify(remote)));
  await writeJsonAtomic(stateFile(wsId), { files: remote.files, ts: Date.now() });
  return { pulled, pushed, deletedL, deletedR, merged, conflicts, failed };
}

// 이 인스턴스가 책임지는 오너(들) — 테넌트 격리의 핵심.
// ARGO_SYNC_OWNER(설치 시 지정한 소유자 id) 또는 페어링 자격의 owner 있으면 그것만. 없으면 로컬에 이미
// 있는 오너만 (버킷 전체를 무차별 순회해 남의 테넌트를 로컬로 빨아들이지 않는다 — 감사 지적).

/* ─── 원격 회사 발견 — 내가 책임지는 오너의 회사만. 새 기기가 자기 회사를 복원하는 경로. ─── */
async function discoverRemote(localOwners) {
  const fixed = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
  const allow = fixed ? new Set([fixed]) : new Set(localOwners);
  if (allow.size === 0) return []; // 지정 오너도, 로컬 회사도 없으면 발견 안 함(무차별 복제 차단)
  const out = []; // [{ owner, wsId }]
  for (const owner of allow) {
    const { data: companies } = await client().storage.from(BUCKET).list(owner, { limit: 200 }).catch(() => ({ data: [] }));
    for (const c of companies ?? []) {
      if (!c.id) out.push({ owner, wsId: c.name }); // 오너 id·회사 slug는 ASCII
    }
  }
  return out;
}

/* ─── 상주 루프 ─── */
const status = (globalThis.__argoSyncStatus ??= { lastTs: null, lastError: '', paywalled: false, plan: null, companies: {} });
export function syncStatus() {
  // plan은 status(globalThis)로 나른다 — 모듈 변수는 Next의 라우트/instrumentation
  // 별도 번들에서 사본이 갈라져 항상 null이 되는 함정(위 lease 주석과 동일 클래스).
  return { ...status, on: syncOn(), leader: isCloudLeader(), companies: { ...status.companies } };
}

async function cycle() {
  if (!(await ensureClient())) { status.lastError = '동기화 자격 없음/만료 — 재로그인 필요'; return; }
  // 크로스 프로세스 락 — 같은 root를 다른 살아있는 프로세스가 동기화 중이면 대기(이중 동기화=대형 유실 차단)
  if (!(await holdSyncLock())) { status.lastError = '같은 데이터 루트를 다른 프로세스가 동기화 중 — 이 인스턴스는 대기'; return; }
  // 계정 키 확보 — 크레덴셜 봉투(v2)의 열쇠. 실패해도 사이클은 계속(크레덴셜만 이번 사이클 제외).
  const keyOwner = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
  await ensureAccountKey(client(), keyOwner);
  // 로컬 회사 수집 (ownerId 있는 것만 — 소유자가 있어야 클라우드에 자리가 있다)
  const targets = new Map(); // wsId → owner
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { /* 루트 없음 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(await readFile(join(WS_ROOT, e.name, 'company.json'), 'utf8'));
      if (meta.ownerId) targets.set(meta.id, meta.ownerId);
    } catch { /* 회사 아님 */ }
  }
  // 원격에만 있는 내 회사 발견 → 로컬 복제 대상에 추가 (새 기기가 자기 회사 복원). 남의 테넌트는 안 봄.
  const localOwners = [...new Set(targets.values())];
  for (const { owner, wsId } of await discoverRemote(localOwners)) {
    if (!targets.has(wsId)) targets.set(wsId, owner);
  }
  const owners = [...new Set(targets.values())];
  // ARGO_SYNC_OWNER/페어링/세션 어디에도 오너가 없던 서비스 셀프호스트 — 로컬 회사에서 찾은 오너로 한 번 더 시도
  if (!keyOwner && owners[0]) await ensureAccountKey(client(), owners[0]);
  // 요금제 게이트(M-2d 스캐폴드) — 세션 모드에만. 서비스 모드(셀프호스트·워커)는 자기 인프라라 통과.
  // 강제는 ARGO_ENFORCE_PLAN=1일 때만(기본 off). 차단 = 조기 return — diff가 안 돌아 부작용 없음.
  status.paywalled = false; // 매 사이클 리셋 — 모드 전환(세션→서비스) 시 stale true 잔존 차단
  if (!loadSyncCreds()) {
    const ent = await syncEntitled(client(), keyOwner || owners[0] || null);
    status.plan = ent.plan; // 차단/통과 무관 — 조회했으면 기록 (globalThis 경유로 라우트 번들에서도 보임)
    if (!ent.ok) { status.lastError = '멀티기기 동기화는 Pro 플랜입니다'; status.paywalled = true; return; }
  }
  if (owners[0]) await renewLease(owners[0]); // 단일 오너 전제(자가 호스팅) — 다중 오너는 P2
  let companyFailed = 0;
  for (const [wsId, owner] of targets) {
    try {
      const r = await syncCompany(wsId, owner);
      status.companies[wsId] = { ts: Date.now(), ...r };
    } catch (e) {
      status.lastError = `${wsId}: ${String(e.message).slice(0, 120)}`;
      console.error(`[argo] 동기화 실패(${wsId}):`, e.message);
      companyFailed++;
    }
  }
  // 모든 회사 동기화 성공 시 스테일 에러 제거 — 회복되면 오래된 에러가 남지 않도록
  if (companyFailed === 0) {
    status.lastError = '';
  }
  status.lastTs = Date.now();
}

/** 즉시 동기화 요청 — 로컬 변경(메시지 전송 등) 직후 호출하면 다음 대기를 건너뛰고 바로 push/pull.
    Next는 라우트·instrumentation 번들이 갈려 모듈 변수가 공유 안 되므로 globalThis로 신호한다(status와 동일 패턴). */
export function nudgeSync() {
  globalThis.__argoSyncPending = true;
  const wake = globalThis.__argoSyncWake;
  if (wake) { globalThis.__argoSyncWake = null; wake(); }
}

export function ensureSync() {
  if (!syncOn()) return;
  if (globalThis.__argoSync) return;
  globalThis.__argoSync = true;
  (async () => {
    if (loadSyncCreds()) {
      try { await ensureClient(); await client().storage.createBucket(BUCKET, { public: false }); } catch { /* 이미 있음 */ }
    }
    console.log(`[argo] 기기 간 동기화 시작 (${Math.round(CYCLE_MS / 1000)}s 주기 · 로컬 변경 시 즉시)`);
    for (;;) {
      globalThis.__argoSyncPending = false;
      try { await cycle(); } catch (e) { status.lastError = String(e.message).slice(0, 120); }
      if (globalThis.__argoSyncPending) continue; // 사이클 도중 nudge 도착 → 대기 없이 즉시 재실행
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); globalThis.__argoSyncWake = null; resolve(); };
        const t = setTimeout(finish, CYCLE_MS);
        globalThis.__argoSyncWake = finish;
      });
    }
  })();
}
