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
import { join, dirname, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT, paths } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { cryptoOn, isSecretRel, sealSecret, openSecret } from './secretbox.mjs';
import { loadSyncCreds, credsEpoch } from './synccreds.mjs';
import { loadDeviceSession, getFreshDeviceSession } from './devicesession.mjs';
import { ensureAccountKey } from './accountkey.mjs';
import { syncEntitled } from './entitlement.mjs';

const BUCKET = 'companies';
const CYCLE_MS = 45_000;
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
async function walk(dir, base = dir, out = {}) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1).split(sep).join('/');
    if (e.isDirectory()) await walk(full, base, out);
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
  let remote = { files: {} };
  try { remote = JSON.parse((await download(manifestKey)).toString()); } catch { /* 최초 푸시 */ }
  const local = await walk(root);
  const state = (await loadState(wsId)).files ?? {};
  let pulled = 0, pushed = 0, deletedL = 0, deletedR = 0, merged = 0, conflicts = 0, failed = 0;

  const relFull = (rel) => join(root, ...rel.split('/'));
  const remoteKey = (rel) => skey(owner, wsId, rel);
  // 시크릿 봉투 — 밀 때 암호화, 받을 때 복호화. 스토리지엔 평문 크레덴셜이 절대 놓이지 않는다.
  // (복호화 실패 = 위변조/키 불일치 → throw → per-file catch가 failed로 집계, 다음 사이클 재시도)
  const pullBuf = async (rel) => { const b = await download(remoteKey(rel)); return isSecretRel(rel) ? openSecret(b) : b; };
  const pushBuf = async (rel) => { const b = await readFile(relFull(rel)); return isSecretRel(rel) ? sealSecret(b) : b; };
  // 로컬 쓰기 — 스레드 파일이면 진행 중 턴과 직렬화(레이스 방지)
  const writeLocal = async (rel, buf, mtime) => {
    const doWrite = async () => {
      const full = relFull(rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, buf);
      if (mtime) await utimes(full, new Date(mtime), new Date(mtime));
    };
    if (isThread(rel)) await withLock(threadLockKey(wsId, rel), doWrite);
    else await doWrite();
  };
  const rmLocal = async (rel) => {
    if (isThread(rel)) await withLock(threadLockKey(wsId, rel), () => rm(relFull(rel), { force: true }));
    else await rm(relFull(rel), { force: true });
  };
  const changed = (a, b) => !a || !b || (a.h ?? `${a.m}:${a.s}`) !== (b.h ?? `${b.m}:${b.s}`);

  const allRels = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(state)]);
  for (const rel of allRels) {
    if (isSecretRel(rel) && !cryptoOn()) continue; // 키 미확보 사이클 — 시크릿은 diff 자체에서 불가시(삭제 오인 차단)
    const l = local[rel], r = remote.files[rel], base = state[rel];
    const localChg = changed(base, l);   // base 대비 로컬 변경(생성/수정/삭제)
    const remoteChg = changed(base, r);   // base 대비 원격 변경
    try {
      // ── 삭제 전파 ──
      if (!l && r) { // 로컬에 없음
        if (base && !remoteChg) { // 내가 지웠고 원격은 그대로 → 원격도 삭제
          await client().storage.from(BUCKET).remove([remoteKey(rel)]);
          delete remote.files[rel]; deletedR++;
        } else if (!base) { // 원격 신규 → 받기
          await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++;
        } else { // 내가 지웠지만 원격도 바뀜 = 충돌 → 원격 부활본을 받아 유실 방지
          await writeLocal(rel, await pullBuf(rel), r.m); local[rel] = r; pulled++; conflicts++;
        }
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
  // plan은 status(globalThis)로 나른다 — 모듈 변수(lastPlan)는 Next의 라우트/instrumentation
  // 별도 번들에서 사본이 갈라져 항상 null이 되는 함정(위 lease 주석과 동일 클래스).
  return { ...status, on: syncOn(), leader: isCloudLeader(), companies: { ...status.companies } };
}

async function cycle() {
  if (!(await ensureClient())) { status.lastError = '동기화 자격 없음/만료 — 재로그인 필요'; return; }
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

export function ensureSync() {
  if (!syncOn()) return;
  if (globalThis.__argoSync) return;
  globalThis.__argoSync = true;
  (async () => {
    if (loadSyncCreds()) {
      try { await ensureClient(); await client().storage.createBucket(BUCKET, { public: false }); } catch { /* 이미 있음 */ }
    }
    console.log('[argo] 기기 간 동기화 시작 (45s 주기)');
    for (;;) {
      try { await cycle(); } catch (e) { status.lastError = String(e.message).slice(0, 120); }
      await new Promise((r) => setTimeout(r, CYCLE_MS));
    }
  })();
}
