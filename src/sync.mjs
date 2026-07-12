// C-1 기기 간 동기화 — "회사 = 폴더" 하나가 진실의 원천이고, 이 엔진이 그 폴더를
// Supabase Storage에 복제해 어느 기기에서 켜도 같은 회사가 열리게 한다.
//
// 방식: 회사별 __manifest__.json(경로→mtime·size)을 기준으로 푸시/풀, 파일 단위 LWW.
// 삭제 전파는 로컬 .sync-state.json(마지막 동기화 시점의 매니페스트)과의 대조로 판별 —
// "내가 지운 것"과 "아직 안 받은 것"을 구분한다.
//
// 제외(동기화 금지): connections.json(봇 토큰 — 시크릿은 기기마다), .gateway*·.gw-offset*(폴러 상태),
// *.status.json(턴 일시 상태), *.lock, .sync-state.json, .device-id.
//
// C-2 최소형: 오너별 _device-lease.json 클라우드 리스 — 두 기기가 동시에 켜져도
// 폴러·루틴 실행 주체는 한 기기만(게이트웨이·스케줄러가 isCloudLeader를 함께 본다).
//
// v1 한계(문서화): 서비스 키 기반(자가 호스팅 전제 — 패키징 앱은 사용자 JWT+RLS로 전환 예정),
// 충돌은 LWW(더 최근 mtime 승) — md 양쪽 보존은 후속.
import { mkdir, readFile, writeFile, readdir, stat, rm, utimes } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT, paths } from './workspace.mjs';

const BUCKET = 'companies';
const CYCLE_MS = 45_000;
const LEASE_TTL_MS = 120_000; // 이 시간 동안 갱신 없으면 다른 기기가 리더를 가져간다

export const SYNC_ON = !!(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.ARGO_SYNC !== '0'
);

const EXCLUDE = (rel) => {
  const base = rel.split('/').pop();
  return (
    rel === 'connections.json' ||
    base.startsWith('.gateway') || base.startsWith('.gw-offset') ||
    base === '.sync-state.json' || base === '.device-id' || base === '.DS_Store' ||
    base.endsWith('.status.json') || base.endsWith('.lock')
  );
};

let sb = null;
const client = () => (sb ??= createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    // 타임아웃 필수 — 기본 fetch는 무한 대기라 요청 하나가 걸리면 동기화 전체가 영원히 멈춘다(실측)
    global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) }) },
  },
));

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
  return !SYNC_ON || leaseState.leader;
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
  // 내 것이거나 만료 — 갱신/획득
  await client().storage.from(BUCKET).upload(
    key, new Blob([JSON.stringify({ deviceId: me, ts: Date.now() })]),
    { upsert: true, contentType: 'application/json' },
  );
  if (!leaseState.leader) console.log(`[argo] 동기화: 실행 리더 획득 (${me})`);
  leaseState.leader = true;
  leaseState.checkedAt = Date.now();
}

/* ─── 로컬 스캔 ─── */
async function walk(dir, base = dir, out = {}) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1).split(sep).join('/');
    if (e.isDirectory()) await walk(full, base, out);
    else if (!EXCLUDE(rel)) {
      const st = await stat(full).catch(() => null);
      if (st) out[rel] = { m: Math.round(st.mtimeMs), s: st.size };
    }
  }
  return out;
}

const stateFile = (wsId) => join(paths(wsId).root, '.sync-state.json');
async function loadState(wsId) {
  try { return JSON.parse(await readFile(stateFile(wsId), 'utf8')); } catch { return { files: {} }; }
}

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

/* ─── 회사 1개 동기화 사이클 — 풀(원격이 최신) → 푸시(로컬이 최신) → 삭제 전파 ─── */
export async function syncCompany(wsId, owner) {
  const root = paths(wsId).root;
  const manifestKey = skey(owner, wsId, '__manifest__.json');
  let remote = { files: {} };
  try { remote = JSON.parse((await download(manifestKey)).toString()); } catch { /* 최초 푸시 */ }
  const local = await walk(root);
  const state = await loadState(wsId);
  let pulled = 0, pushed = 0, deletedL = 0, deletedR = 0, failed = 0;

  // ① 풀 — 원격에 있고 (로컬에 없거나 원격이 더 최신)인 파일. 단, "내가 방금 지운 파일"은 제외
  for (const [rel, r] of Object.entries(remote.files)) {
    const l = local[rel];
    const deletedLocally = !l && state.files[rel]; // 지난 동기화엔 있었는데 지금 없다 = 로컬 삭제
    if (deletedLocally) continue;
    if (!l || r.m > l.m + 1500) { // 1.5초 여유 — mtime 해상도·시계 오차 완충
      try {
        const buf = await download(skey(owner, wsId, rel));
        const full = join(root, ...rel.split('/'));
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, buf);
        await utimes(full, new Date(r.m), new Date(r.m)); // mtime 정렬 — 재푸시 루프 방지
        local[rel] = { m: r.m, s: buf.length };
        pulled++;
      } catch { failed++; } // 파일 하나가 막혀도 나머지는 계속 — 다음 사이클이 재시도한다
    }
  }

  // ② 푸시 — 로컬에 있고 (원격에 없거나 로컬이 더 최신)인 파일
  for (const [rel, l] of Object.entries(local)) {
    const r = remote.files[rel];
    if (!r || l.m > r.m + 1500) {
      try {
        const buf = await readFile(join(root, ...rel.split('/')));
        await upload(skey(owner, wsId, rel), buf);
        remote.files[rel] = { m: l.m, s: l.s };
        pushed++;
      } catch { failed++; }
    }
  }

  // ③ 삭제 전파 — 로컬 삭제 → 원격 제거 / 원격 삭제(매니페스트에서 사라짐) → 로컬 제거
  for (const rel of Object.keys(state.files)) {
    const inLocal = !!local[rel];
    const inRemote = !!remote.files[rel];
    if (!inLocal && inRemote) { // 이 기기에서 지움 → 원격에도 반영
      await client().storage.from(BUCKET).remove([skey(owner, wsId, rel)]);
      delete remote.files[rel];
      deletedR++;
    } else if (inLocal && !inRemote) { // 다른 기기에서 지움 → 로컬도 제거
      await rm(join(root, ...rel.split('/')), { force: true });
      delete local[rel];
      deletedL++;
    }
  }

  await upload(manifestKey, Buffer.from(JSON.stringify(remote)));
  await writeFile(stateFile(wsId), JSON.stringify({ files: remote.files, ts: Date.now() }));
  return { pulled, pushed, deletedL, deletedR };
}

/* ─── 원격 회사 발견 — 새 기기가 계정의 회사들을 자동으로 들여온다 ─── */
async function discoverRemote() {
  const out = []; // [{ owner, wsId }]
  const { data: owners } = await client().storage.from(BUCKET).list('', { limit: 100 });
  for (const o of owners ?? []) {
    if (o.id) continue; // 파일은 스킵 — 폴더(오너)만
    const { data: companies } = await client().storage.from(BUCKET).list(o.name, { limit: 100 });
    for (const c of companies ?? []) {
      if (!c.id) out.push({ owner: o.name, wsId: c.name }); // 오너 UUID·회사 slug는 항상 ASCII — 인코딩 안 탄다
    }
  }
  return out;
}

/* ─── 상주 루프 ─── */
const status = (globalThis.__argoSyncStatus ??= { on: SYNC_ON, lastTs: null, lastError: '', companies: {} });
export function syncStatus() {
  return { ...status, leader: isCloudLeader(), companies: { ...status.companies } };
}

async function cycle() {
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
  // 원격에만 있는 회사 발견 → 로컬 복제 대상에 추가 (새 기기 시나리오)
  for (const { owner, wsId } of await discoverRemote()) {
    if (!targets.has(wsId)) targets.set(wsId, owner);
  }
  const owners = [...new Set(targets.values())];
  if (owners[0]) await renewLease(owners[0]); // 단일 오너 전제(자가 호스팅) — 다중 오너는 P2
  for (const [wsId, owner] of targets) {
    try {
      const r = await syncCompany(wsId, owner);
      status.companies[wsId] = { ts: Date.now(), ...r };
    } catch (e) {
      status.lastError = `${wsId}: ${String(e.message).slice(0, 120)}`;
      console.error(`[argo] 동기화 실패(${wsId}):`, e.message);
    }
  }
  status.lastTs = Date.now();
}

export function ensureSync() {
  if (!SYNC_ON) return;
  if (globalThis.__argoSync) return;
  globalThis.__argoSync = true;
  (async () => {
    try {
      await client().storage.createBucket(BUCKET, { public: false });
    } catch { /* 이미 있음 */ }
    console.log('[argo] 기기 간 동기화 시작 (45s 주기)');
    for (;;) {
      try { await cycle(); } catch (e) { status.lastError = String(e.message).slice(0, 120); }
      await new Promise((r) => setTimeout(r, CYCLE_MS));
    }
  })();
}
