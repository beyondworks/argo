// 두 기기 텔레그램 클레임 하네스(PR #1197 엄격 검수의 하네스를 그대로 옮김) — 기기 A는 실제 코드(renewLease + renewTokenClaims = leaseTick의 두 줄, leaseReadInterval 박자),
// 기기 B는 새 판 판정식(claimTtlFor + claimDecision, 없으면 base의 120초)을 같은 가짜 저장소에 적용한다. 'A mine && B mine'인 초(겹침)와 넘겨받기까지 걸린 초(공백)를 잰다.
// 사용: SCEN=<preempt|stall|sleep|netA|move> [SRC=<저장소 루트>] node test/helpers/tg-twodev.mjs — 결과는 '@@' 뒤 JSON 한 줄(test/tg-claims-twodev.test.mjs).
import { mock } from 'node:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = process.env.SRC || new URL('../..', import.meta.url).pathname; const SCEN = process.env.SCEN;
const root = mkdtempSync(join(tmpdir(), 'rv1197-'));
process.env.ARGO_ROOT = root; process.env.ARGO_SYNC = '1';
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-rv', email: '' } }), { mode: 0o600 });
const sync = await import(join(SRC, 'src/sync.mjs'));
const { getDeviceId } = await import(join(SRC, 'src/workspace.mjs'));
const A = await getDeviceId();
const B = 'B-Server-0badf00d';
const OWNER = 'owner-rv'; const TOK = 'shared-token';
const CK = `${OWNER}/.tg-claims/${sync.tokenClaimHash(TOK)}.json`;
const LK = `${OWNER}/_device-lease.json`;

const objs = new Map(); const n = { put: 0, get: 0, list: 0, del: 0 };
let aDown = false; // A의 Storage 요청만 실패(A→Supabase 끊김, 텔레그램은 됨)
let aFailGets = 0; // A의 다음 GET n번 실패(일시 오류)
const err = { name: 'StorageApiError', message: 'fetch failed', status: 503, statusCode: '503' };
const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
const bucket = {
  async download(key) { n.get += 1; if (aFailGets > 0 && String(key).startsWith(CK)) { aFailGets -= 1; return { data: null, error: err }; } if (aDown) return { data: null, error: err }; const b = objs.get(String(key).split('?')[0]); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
  async upload(key, blob) { n.put += 1; if (aDown) return { data: null, error: err }; objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
  async remove(keys) { for (const k of keys) { n.del += 1; objs.delete(k); } return { data: [], error: null }; },
  async list(prefix) { n.list += 1; if (aDown) return { data: null, error: err }; const out = []; for (const [k, b] of objs) if (k.startsWith(`${prefix}/`)) out.push({ name: k.slice(prefix.length + 1), metadata: { eTag: `"${createHash('md5').update(b).digest('hex')}"` } }); return { data: out, error: null }; },
};
sync._setSyncClientForTest({ storage: { from: () => bucket } });
const get = (k) => { const b = objs.get(k); return b ? JSON.parse(b.toString()) : null; };
const set = (k, d) => objs.set(k, Buffer.from(JSON.stringify(d)));

const t0 = Date.now();
mock.timers.enable({ apis: ['Date'], now: t0 });
const T = () => Math.round((Date.now() - t0) / 1000);
sync.setClaimTokens([TOK]);

// B(새 판 판정식) — 클레임 판정 30초, 다시 쓰기 40초(엄격 판정 = 종전 규칙). holderB = B가 마지막으로 읽은 리스 글의 주인.
const B_ = { mine: false, holder: null, lastJudge: -Infinity, wroteAt: 0 };
const ttlFor = (cur, holder, now) => (typeof sync.claimTtlFor === 'function' ? sync.claimTtlFor(cur, holder, now) : sync.TG_CLAIM_TTL_MS);
function bJudge(now) {
  if (now - B_.lastJudge < 30_000) return;
  B_.lastJudge = now;
  const cur = get(CK);
  if (sync.claimDecision(cur, B, now, ttlFor(cur, B_.holder, now)) === 'other') { if (B_.mine) log(`B 양보 → ${cur.deviceId}`); B_.mine = false; return; }
  if (B_.mine && cur?.deviceId === B && now - cur.ts < 40_000) return;
  set(CK, { deviceId: B, nonce: randomUUID(), ts: now });
  if (!B_.mine) log(`B 클레임 획득(A 글 나이 ${cur ? Math.round((now - cur.ts) / 1000) : '-'}초, B가 본 리스 주인 ${B_.holder?.deviceId === B ? 'B' : B_.holder?.deviceId === A ? 'A' : '-'})`);
  B_.mine = true;
}
const events = []; const log = (s) => events.push(`t=${T()}s ${s}`);

let aAlive = true; let aAwake = true; let nextA = Date.now();
async function aTick() {
  await sync.renewLease(OWNER, { runnerUsable: true });
  await sync.renewTokenClaims(OWNER);
  nextA = Date.now() + sync.leaseReadInterval();
}
let overlap = 0; let firstOverlap = null; let lastOverlap = null; let aMineWhileAsleep = 0;
let prevA = null;
async function second() {
  mock.timers.tick(1_000);
  if (aAlive && aAwake && Date.now() >= nextA) await aTick();
  const aMine = sync.tokenOwnership(TOK).mine;
  if (aMine !== prevA) { log(`A tokenOwnership.mine=${aMine}${aAwake ? '' : ' (자는 중)'}`); prevA = aMine; }
  if (aMine && B_.mine && aAwake) { overlap += 1; firstOverlap ??= T(); lastOverlap = T(); }
}

// 1단계: A 혼자 5분(혼자 모드 판정 확인)
await aTick();
for (let i = 0; i < 300 + Number(process.env.PHASE ?? 0); i++) await second();
const docA = get(CK);
log(`A 클레임 글: lease=${docA?.lease} ttl=${docA?.ttl} 나이=${Math.round((Date.now() - docA.ts) / 1000)}초`);

if (SCEN === 'preempt') {
  // B = argo run(우선 역할)이 처음 켜져 A의 살아 있는 리스를 가져온다(쓰기 → 800ms 확인 → holder=B, 22초 뒤 담당). B는 60초마다 리스를 다시 쓴다.
  let bLeaseAt = Date.now(); set(LK, { deviceId: B, token: 'tb', ts: bLeaseAt, preferred: true }); B_.holder = { deviceId: B, ts: bLeaseAt };
  log('B(우선 역할) 리스 가져옴');
  for (let i = 0; i < 300; i++) {
    if (Date.now() - bLeaseAt >= 60_000) { bLeaseAt = Date.now(); set(LK, { deviceId: B, token: 'tb', ts: bLeaseAt, preferred: true }); B_.holder = { deviceId: B, ts: bLeaseAt }; }
    bJudge(Date.now());
    await second();
  }
} else if (SCEN === 'stall' || SCEN === 'netA') {
  // stall: A의 리스 타이머(leaseTick)가 멈춤(폴러·게이트웨이는 살아 있음). netA: A→Supabase만 실패(A의 판정은 돌지만 읽기·쓰기 실패), 텔레그램은 됨.
  if (SCEN === 'stall') aAlive = false; else aDown = true;
  log(SCEN === 'stall' ? 'A 리스 타이머 멈춤' : 'A의 Supabase 요청 실패 시작');
  for (let i = 0; i < 1500; i++) {
    // B(일반, 엄격 판정): 30초마다 리스를 읽고, 만료면 가져온다(쓰기·확인 → holder=B).
    if (i % 30 === 0) {
      const l = get(LK);
      if (l && Date.now() - l.ts < sync.LEASE_TTL_MS && l.deviceId !== B) B_.holder = { deviceId: l.deviceId, ts: l.ts };
      else { set(LK, { deviceId: B, token: 'tb', ts: Date.now() }); if (B_.holder?.deviceId !== B) log('B 리스 가져옴(A 리스 만료)'); B_.holder = { deviceId: B, ts: Date.now() }; }
    }
    bJudge(Date.now());
    await second();
  }
} else if (SCEN === 'move') {
  // 사용자가 A에서 봇을 빼고 B에 연결(토큰 옮기기). A의 폴러는 연결이 바뀐 즉시 멈춘다(gateway alive 집합). A는 리스 보유를 계속한다.
  // 해제 청소(renewTokenClaims의 removed 루프)의 소유 확인 GET이 한 번 실패(일시 오류) — 청소는 다시 시도하지 않는다(L-B).
  aFailGets = Number(process.env.FAILS ?? 1);
  log(`A에서 토큰 해제(폴러 멈춤), 청소 GET 실패 ${aFailGets}번 주입`);
  const tMove = Date.now(); let gotAt = null;
  for (let i = 0; i < 1500; i++) {
    if (i % 10 === 0) sync.setClaimTokens([]); // 게이트웨이 10초 등록
    if (i % 30 === 0) { const l = get(LK); B_.holder = l ? { deviceId: l.deviceId, ts: l.ts } : null; }
    bJudge(Date.now());
    if (B_.mine && gotAt == null) gotAt = Date.now();
    await second();
  }
  log(`B가 넘겨받기까지(아무도 폴링 안 함) ${gotAt == null ? '25분 안에 못 받음' : Math.round((gotAt - tMove) / 1000) + '초'}`);
  globalThis.__gapSec = gotAt == null ? null : Math.round((gotAt - tMove) / 1000);
} else if (SCEN === 'sleep') {
  // A가 잠듦(프로세스 정지) 8분 → 그동안 B가 리스·클레임을 가져감 → A가 깸. 깬 순간 A의 tokenOwnership(게이트웨이 10초 sync가 보는 값)을 본다.
  aAwake = false; log('A 잠듦');
  for (let i = 0; i < 480; i++) {
    if (i % 30 === 0) {
      const l = get(LK);
      if (l && Date.now() - l.ts < sync.LEASE_TTL_MS && l.deviceId !== B) B_.holder = { deviceId: l.deviceId, ts: l.ts };
      else { set(LK, { deviceId: B, token: 'tb', ts: Date.now() }); if (B_.holder?.deviceId !== B) log('B 리스 가져옴(A 리스 만료)'); B_.holder = { deviceId: B, ts: Date.now() }; }
    }
    bJudge(Date.now());
    await second();
  }
  const atWake = sync.tokenOwnership(TOK); globalThis.__atWake = atWake;
  log(`A 깸 — 첫 판정 전 tokenOwnership = ${JSON.stringify(atWake)} / B.mine=${B_.mine}`);
  aAwake = true; nextA = Date.now() + 2_000; // waitLeaseTick이 2초 안에 깸을 알아채고 판정
  for (let i = 0; i < 60; i++) { bJudge(Date.now()); await second(); }
}
mock.timers.reset();
process.stdout.write('\n@@' + JSON.stringify({ scen: SCEN, overlapStateSec: overlap, firstOverlap, lastOverlap, gapSec: globalThis.__gapSec ?? null, atWake: globalThis.__atWake ?? null, events }) + '\n');
rmSync(root, { recursive: true, force: true });
process.exit(0);
