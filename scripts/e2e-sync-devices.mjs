#!/usr/bin/env node
// 기기 간 동기화 E2E 관문(사람이 돌린다 — CI에는 넣지 않는다: 판마다 standalone 빌드가 필요하고 칸 전체가 약 1시간이라 맥 CI 30분 제한에 걸린다).
// 2026-10-30 고객 C(메인 PC의 회사가 클라우드에 안 올라감)에서 나온 경우를 모두 실제 실행본으로 다시 돈다 — 옛 판 v0.1.120이 남긴 상태(남은 페어링 자격·게스트 표시·
// 미래 시각 잠금·살아 있는 옛 판이 쥔 잠금)와 잠자기, 앱 데이터 폴더를 같이 쓰는 argo CLI(앱 단독·CLI 단독·둘 다·전환·강제 종료·로컬·한 번 실행 명령).
//
// 실행본: 판마다 `ARGO_STANDALONE=1 next build`(공개 설정은 가짜 값을 빌드에 박는다 — 설치본처럼 빌드 값 인라인)의 .next/standalone/server.js를
// 앱 사이드카와 같은 env(ARGO_ROOT·PORT·HOSTNAME 127.0.0.1·ARGO_STANDALONE=1·NODE_ENV=production·ARGO_PARENT_PID)로 띄운다. CLI는 같은 빌드의
// bin/argo.mjs를 앱 공유 모드(ARGO_CLI_APP=1, 데이터 폴더 = 앱 폴더)·대화형으로 띄운다(가상 터미널: script).
// 클라우드: test/helpers/fake-supabase-http.mjs(엄격 가짜 Supabase — 실제 Storage·PostgREST 응답 모양). 색인 RPC는 저장된 객체에서 계정의 회사 목록을 뽑는다.
// 실데이터·:3001·운영은 건드리지 않는다: 데이터 폴더·HOME은 칸마다 새 임시 폴더, 서버는 빈 포트, 클라우드는 127.0.0.1의 가짜.
//
// 사용:
//   node scripts/e2e-sync-devices.mjs --new <ref|빌드 폴더> [--old <ref|빌드 폴더>] [--cells all|core|S|K|<칸,…>] [--out <폴더>] [--keep]
//   --new  판정할 판(기본 HEAD). git ref면 임시 워크트리에 빌드, 폴더면 그 폴더의 .next/standalone을 쓴다(저장소 루트 — bin·src 포함).
//   --old  옛 판(기본 v0.1.120) — S 칸의 회사 생성과 '살아 있는 옛 판' 프로세스.
//   --cells core = K1·K3·S-custC(짧은 핵심), S = S 계열, K = K 계열, all(기본) = 전부.
//   S-envOff(사이드카가 ARGO_SYNC=0을 물려받음)는 정책 A(2026-10-31)의 '물려받은 값을 무시하고 동기화한다'를 본다 — 그 전 판은 이 칸이 FAIL이다(꼬리표 sync/off.*).
// 출력: <out>/<칸>.json(칸별 측정·판정), <out>/summary.json, 마지막 줄 요약 `e2e-sync-devices: N/M PASS …`. 하나라도 FAIL이면 exit 1.
// 정리: 임시 폴더·빌드 워크트리·띄운 프로세스(프로세스 그룹)를 끝날 때(정상·예외·Ctrl+C) 지우고, 이 실행의 폴더를 가리키는 프로세스가 0개인지 확인한다.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, createWriteStream, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { startFakeSupabase } = await import(join(REPO, 'test', 'helpers', 'fake-supabase-http.mjs'));

/* ─── 인자 ─── */
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const NEW_SPEC = opt('new', 'HEAD'), OLD_SPEC = opt('old', 'v0.1.120');
const KEEP = argv.includes('--keep');
const RUN = mkdtempSync(join(tmpdir(), 'argo-e2e-sync-devices-'));
const OUT = resolve(opt('out', join(RUN, 'out'))); mkdirSync(OUT, { recursive: true });
const S_OBSERVE_MS = Number(process.env.E2E_S_OBSERVE_MS) || 120_000; // 교체 뒤 관찰(2026-10-30 기준)
const S_CELLS = ['S-control', 'S-creds', 'S-guest', 'S-future', 'S-oldRunning', 'S-oldEnded', 'S-custC', 'S-all', 'S-allEnded', 'S-sleep', 'S-sleepctl', 'S-envOff'];
const K_CELLS = ['K1-cliOnly', 'K2-appOnly', 'K3-both', 'K4-cliToApp', 'K5-appToCli', 'K6a-cliKilled', 'K6b-cliKill9', 'K7-exit', 'K8-local', 'K9-oneShot', 'K10-tag'];
const CORE = ['K1-cliOnly', 'K3-both', 'S-custC'];
const cellsArg = opt('cells', 'all');
const CELLS = cellsArg === 'all' ? [...S_CELLS, ...K_CELLS] : cellsArg === 'core' ? CORE : cellsArg === 'S' ? S_CELLS : cellsArg === 'K' ? K_CELLS : cellsArg.split(',').map((s) => s.trim()).filter(Boolean);
for (const c of CELLS) if (![...S_CELLS, ...K_CELLS].includes(c)) { console.error(`알 수 없는 칸: ${c}`); process.exit(2); }

/* ─── 정리(trap) ─── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = new Set();
const worktrees = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const p of kids) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 끝남 */ } }
  for (const w of worktrees) { try { execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', w], { stdio: 'ignore' }); } catch { /* 이미 */ } }
  try { execFileSync('git', ['-C', REPO, 'worktree', 'prune'], { stdio: 'ignore' }); } catch { /* */ }
  if (!KEEP) {
    for (const e of readdirSync(RUN)) if (join(RUN, e) !== OUT) rmSync(join(RUN, e), { recursive: true, force: true });
    if (!OUT.startsWith(RUN)) rmSync(RUN, { recursive: true, force: true }); // 결과를 바깥 폴더에 썼으면 실행 폴더째 지운다
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
const everPids = [];
const track = (p) => { kids.add(p); everPids.push(p.pid); p.on('exit', () => kids.delete(p)); return p; };
const stop = async (p, sig = 'SIGTERM') => { if (!p) return; try { process.kill(-p.pid, sig); } catch { /* 끝남 */ } await sleep(1500); try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 끝남 */ } };
const freePort = () => new Promise((r) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/* ─── 판 준비 ─── */
const PUB = { NEXT_PUBLIC_SUPABASE_URL: 'https://e2e-fake.supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-e2e-fixture' };
function prepare(spec, label) {
  const asPath = resolve(spec);
  if (existsSync(join(asPath, '.next', 'standalone', 'server.js'))) return { dir: asPath, label: `${label}:${asPath}` };
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', `${spec}^{commit}`], { encoding: 'utf8' }).trim();
  const dir = join(RUN, `build-${label}`);
  console.log(`[e2e] ${label} = ${spec}(${sha}) 빌드 — ${dir}`);
  execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, sha], { stdio: 'ignore' });
  worktrees.push(dir);
  // node_modules: 맥은 APFS 복제(공간·시간 거의 0), 그 밖은 심볼릭 링크
  if (process.platform === 'darwin') execFileSync('cp', ['-c', '-R', join(REPO, 'node_modules'), join(dir, 'node_modules')]);
  else symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  const env = { ...process.env, ...PUB, ARGO_STANDALONE: '1' }; delete env.SUPABASE_SERVICE_ROLE_KEY;
  const r = spawnSync('npx', ['next', 'build'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  writeFileSync(join(OUT, `build-${label}.log`), `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (r.status !== 0 || !existsSync(join(dir, '.next', 'standalone', 'server.js'))) throw new Error(`${label} 빌드 실패 — ${join(OUT, `build-${label}.log`)}`);
  cpSync(join(dir, '.next', 'static'), join(dir, '.next', 'standalone', '.next', 'static'), { recursive: true }); // 사이드카 stage와 같은 배치
  if (existsSync(join(dir, 'public'))) cpSync(join(dir, 'public'), join(dir, '.next', 'standalone', 'public'), { recursive: true });
  return { dir, label: `${label}:${spec}(${sha})` };
}

/* ─── 공용 ─── */
const UID = 'u-e2e-1', WS = 'co-cust-c';
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
// 동기화 대상 — sync.mjs EXCLUDE의 구조적 규칙(점 파일 상태·잠금·임시·기기 로컬 폴더). EXCLUDE의 마지막 줄(암호화 꺼짐이면 제외)은 이 프로세스에 계정 키가 없어 쓰지 않는다.
const LOCAL_DIRS = new Set(['.local-assets', 'mail', 'sessmsg', '.sessions', '.msgr-journal', '.turn-traces', '.sync-conflicts']);
const excluded = (rel) => { const top = rel.split('/')[0], base = rel.split('/').pop(); return LOCAL_DIRS.has(top) || top.startsWith('.gw-queue') || top.startsWith('.msgr-archive') || top === '.assistant' || base.startsWith('.') || base.endsWith('.lock') || base.endsWith('.status.json') || base.includes('.corrupt'); };
function eligible(root) {
  const ws = join(root, WS), out = {};
  if (!existsSync(ws)) return out;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else { const rel = relative(ws, f).split('\\').join('/'); if (!excluded(rel)) out[rel] = hash(readFileSync(f)); } } };
  walk(ws); return out;
}
async function fake(userId = UID) {
  const idx = { get companies() { const s = new Set(); for (const k of f.store.keys()) { const m = k.match(new RegExp(`^companies/${userId}/([^/]+)/__manifest__`)); if (m) s.add(m[1]); } return [...s]; }, tombstones: [] };
  const f = await startFakeSupabase({ plan: 'pro', userId, syncIndex: idx });
  f.inflight = new Map(); f.maxInflight = 0; f.tags = [];
  f.fault = (req, path) => {
    if (path.endsWith('/rpc/argo_min_app_version')) f.tags.push(String(req.headers['x-client-info'] ?? '').split(' ').filter((x) => x.startsWith('sync/')).join(' '));
    const m = path.match(/companies\/[^/]+\/([^/]+)\/__manifest__/); // 같은 회사 manifest 요청의 동시 진행 수(두 사이클·두 프로세스가 같은 회사를 겹쳐 돌면 2 이상)
    if (m) { const n = (f.inflight.get(m[1]) ?? 0) + 1; f.inflight.set(m[1], n); f.maxInflight = Math.max(f.maxInflight, n); req.once('close', () => f.inflight.set(m[1], f.inflight.get(m[1]) - 1)); }
    return null;
  };
  f.objs = (owner = userId) => [...f.store.keys()].filter((k) => k.startsWith(`companies/${owner}/${WS}/`) && !k.includes('__manifest__'));
  f.ups = (from = 0, to = Infinity) => f.hits.filter((h) => h.t >= from && h.t < to && /^(POST|PUT) \/storage\/v1\/object\/companies\//.test(h.k)).length;
  f.rpm = (ms = 60_000) => { const e = Date.now(); return Math.round(f.hits.filter((h) => h.t >= e - ms).length * (60_000 / ms)); };
  return f;
}
const seedSession = (root, url) => { mkdirSync(root, { recursive: true }); writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url, anonKey: PUB.NEXT_PUBLIC_SUPABASE_ANON_KEY, access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: '' } }), { mode: 0o600 }); };
async function makeCompany(build, home, root, ownerId = UID) {
  const code = `const w = await import(${JSON.stringify(join(build.dir, 'src', 'workspace.mjs'))}); await w.createCompany(${JSON.stringify(WS)}, '고객C 회사', 'owner', ${ownerId ? JSON.stringify(ownerId) : 'null'}, 'ko');`;
  await new Promise((res, rej) => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, HOME: home, ARGO_ROOT: root }, stdio: 'ignore' }); p.on('exit', (c) => (c ? rej(new Error('createCompany')) : res())); });
  const ws = join(root, WS);
  for (const d of ['agents', 'notes', 'files']) mkdirSync(join(ws, d), { recursive: true });
  for (const [s, n] of [['alpha', '알파'], ['beta', '베타']]) writeFileSync(join(ws, 'agents', `${s}.md`), `---\nname: ${n}\nrole: 검증\n---\n${n} 에이전트 카드 ${s}.\n`);
  for (let i = 1; i <= 5; i++) writeFileSync(join(ws, 'notes', `note-${i}.md`), `# 노트 ${i}\n고객 C 메인 PC 노트 ${i} — ${'내용 '.repeat(i * 20)}\n`);
  writeFileSync(join(ws, 'files', 'data.csv'), 'a,b\n1,2\n3,4\n');
  writeFileSync(join(ws, 'files', 'blob.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
}
function logFile(cell, name) { const f = join(OUT, `${cell}.${name}.log`); writeFileSync(f, ''); return f; }
// 앱 사이드카와 같은 env로 standalone 서버를 띄운다
async function app(build, { home, root, log, extra = {} }) {
  const out = createWriteStream(log, { flags: 'a' });
  const port = await freePort();
  const p = track(spawn(process.execPath, ['server.js'], { cwd: join(build.dir, '.next', 'standalone'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, PORT: String(port), HOSTNAME: '127.0.0.1', ARGO_ROOT: root, ARGO_STANDALONE: '1', NODE_ENV: 'production', ARGO_PARENT_PID: String(process.pid), ARGO_AGENT_LINK: '0', ...extra } }));
  p.stdout.pipe(out); p.stderr.pipe(out); p.port = port; return p;
}
// 앱 공유 CLI(대화형은 가상 터미널) — script는 표준 입력이 진짜 파이프여야 한다(Node 'pipe'는 소켓이라 tcgetattr 실패) → 셸 파이프로 열린 채 둔다
function cli(build, { home, log, args = [] }) {
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const cmd = [process.execPath, join(build.dir, 'bin', 'argo.mjs'), ...args].map(q).join(' ');
  const pty = process.platform === 'darwin' ? `script -q /dev/null ${cmd}` : `script -qfc ${q(cmd)} /dev/null`;
  const out = createWriteStream(log, { flags: 'a' });
  const p = track(spawn('/bin/sh', ['-c', `sleep 900 | exec ${pty}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, ARGO_CLI_APP: '1', ...PUB, LANG: 'ko_KR.UTF-8', NO_COLOR: '1', TERM: 'xterm', ARGO_AGENT_LINK: '0', ARGO_NATIVE_RUNNERS: 'off', ARGO_MODEL_CATALOG: 'off' } }));
  p.stdout.pipe(out); p.stderr.pipe(out); return p;
}
// 잠자기 흉내 — 서버 안에서 50초마다 벽시계(Date.now)만 40초 건너뛴다(타이머는 단조 시계라 제때 돈다). 감시는 30초(> 동기화 주기 8초, 실제 10분 > 8초와 같은 관계).
const CLOCKJUMP = join(RUN, 'clockjump.mjs');
writeFileSync(CLOCKJUMP, `const jump = Number(process.env.E2E_JUMP_MS ?? 0), every = Number(process.env.E2E_JUMP_EVERY_MS ?? 50000);
const realNow = Date.now; let off = 0; Date.now = () => realNow() + off;
if (jump > 0) { const iv = setInterval(() => { off += jump; }, every); iv.unref?.(); }\n`);
const lockPid = (root) => { try { return JSON.parse(readFileSync(join(root, '.sync-process.lock'), 'utf8')).pid; } catch { return null; } };
const grepAll = (txt, re) => [...new Set(txt.match(re) ?? [])];
async function laptopCheck(build, url, cell, mainAfter) {
  const home = mkdtempSync(join(RUN, 'lap-')); const root = join(home, 'root'); seedSession(root, url); writeFileSync(join(root, '.device-id'), 'e2e-laptop-0001');
  const l = await app(build, { home, root, log: logFile(cell, 'laptop') });
  for (let t = 0; t < 40_000; t += 1000) { await sleep(1000); if (existsSync(join(root, WS, 'notes', 'note-5.md'))) { await sleep(10_000); break; } }
  await stop(l);
  const lf = eligible(root);
  const nk = Object.keys(mainAfter).filter((k) => /^(notes|agents)\//.test(k));
  return {
    laptopFiles: Object.keys(lf).length,
    laptopMissing: Object.keys(mainAfter).filter((k) => !(k in lf)),
    laptopExtra: Object.keys(lf).filter((k) => !(k in mainAfter)),
    hashMismatch: Object.keys(mainAfter).filter((k) => k in lf && lf[k] !== mainAfter[k]),
    notesAgentsHashEqual: nk.length > 0 && nk.every((k) => lf[k] === mainAfter[k]),
    companiesLaptop: readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, 'company.json'))).map((e) => e.name),
  };
}
const syncedPass = (r) => ({
  uploaded: r.objects > 0,
  countsMatch: r.laptopFiles === r.mainFiles && r.laptopMissing.length === 0 && r.laptopExtra.length === 0,
  companiesMatch: JSON.stringify(r.companiesLaptop) === JSON.stringify([WS]),
  hashes: r.notesAgentsHashEqual && r.hashMismatch.length === 0,
  noLocalDelete: r.localDeleted === 0,
  noConcurrent: r.maxInflightSameCompany <= 1,
});

/* ─── S 계열 — 옛 판이 남긴 상태에서 새 판으로 교체 ─── */
async function runS(cell, NEW, OLD) {
  const st = { creds: ['S-creds', 'S-custC', 'S-all', 'S-allEnded'].includes(cell), guest: ['S-guest', 'S-all', 'S-allEnded'].includes(cell), future: ['S-future', 'S-all', 'S-allEnded'].includes(cell),
    oldRunning: ['S-oldRunning', 'S-custC', 'S-all'].includes(cell), oldEnded: ['S-oldEnded', 'S-allEnded'].includes(cell), sleep: cell === 'S-sleep', sleepctl: cell === 'S-sleepctl' };
  const r = { cell, states: st };
  const F = await fake(), OLDT = await fake('u-old-pair'); // 우리 클라우드 / 옛 페어링 파일이 가리키던 다른 목적지
  try {
    const home = mkdtempSync(join(RUN, 'main-')); const root = join(home, 'root');
    seedSession(root, F.url); writeFileSync(join(root, '.device-id'), 'e2e-main-0001');
    await makeCompany(OLD, home, root);
    const before = eligible(root);
    let old = null;
    if (st.creds) writeFileSync(join(root, '.sync-credentials.json'), JSON.stringify({ url: OLDT.url, key: 'svc-stale-fixture', owner: 'u-old-pair' }), { mode: 0o600 });
    if (st.guest) writeFileSync(join(root, '.guest-mode.json'), JSON.stringify({ enabled: true, ts: '2026-10-14T00:00:00.000Z' }));
    if (st.future) { const s = track(spawn('sleep', ['900'], { detached: true, stdio: 'ignore' })); writeFileSync(join(root, '.sync-process.lock'), JSON.stringify({ pid: s.pid, ts: Date.now() + 86_400_000 })); } // 살아 있는 남의 pid(Windows pid 재사용 흉내)
    if (st.oldRunning || st.oldEnded) { old = await app(OLD, { home, root, log: logFile(cell, 'old') }); await sleep(25_000); if (st.oldEnded) { await stop(old); old = null; } }
    const extra = (st.sleep || st.sleepctl) ? { NODE_OPTIONS: `--import ${CLOCKJUMP}`, ARGO_SYNC_WATCHDOG_MS: '30000', E2E_JUMP_MS: st.sleep ? '40000' : '0', E2E_JUMP_EVERY_MS: '50000' } : {};
    const mainLog = logFile(cell, 'main');
    const tSwap = Date.now();
    const srv = await app(NEW, { home, root, log: mainLog, extra });
    for (let t = 0; t < S_OBSERVE_MS && !(r.firstUploadMs ??= null); t += 1000) { await sleep(1000); if (F.objs().length > 0) r.firstUploadMs = Date.now() - tSwap; }
    while (Date.now() - tSwap < S_OBSERVE_MS) await sleep(1000);
    r.reqPerMin = F.rpm();
    if (old) { // 옛 판이 살아 있던 칸 — 옛 판을 끈 뒤 20초 동안 옛 목적지로 가는 요청이 0이어야 새 판이 옛 키를 쓰지 않은 것이다(옛 판 요청과 가른다)
      await stop(old); old = null; const t = Date.now(); await sleep(20_000);
      r.staleHitsNewOnly = OLDT.hits.filter((h) => h.t >= t).length;
    } else r.staleHitsNewOnly = OLDT.hits.filter((h) => h.t >= tSwap).length;
    r.objects = F.objs().length; r.maxInflightSameCompany = F.maxInflight;
    const mlog = readFileSync(mainLog, 'utf8');
    r.watchdogRestarts = (mlog.match(/sync watchdog restart/g) ?? []).length;
    r.takeover = grepAll(mlog, /sync lock takeover reason=\w+/g); r.phases = grepAll(mlog, /sync phase=[\w-]+ err=[\w-]+/g).slice(0, 6);
    r.tags = [...new Set(F.tags)];
    await stop(srv);
    const after = eligible(root);
    r.mainFiles = Object.keys(after).length; r.localDeleted = Object.keys(before).filter((k) => !(k in after)).length;
    Object.assign(r, await laptopCheck(NEW, F.url, cell, after));
    r.pass = { ...syncedPass(r), noStaleKey: r.staleHitsNewOnly === 0, ...(st.sleep || st.sleepctl ? { noWatchdogRestart: r.watchdogRestarts === 0 } : {}) };
  } finally { await F.close(); await OLDT.close(); }
  return r;
}

/* ─── S-envOff — 앱 사이드카가 부모 env의 ARGO_SYNC=0을 물려받은 경우(2026-10-30 고객 C 재판정 추정) ───
   정책 A(2026-10-31): 데스크톱 앱은 물려받은 ARGO_SYNC=0을 따르지 않는다(src/sync.mjs ignoreInheritedSyncOff). 이 칸은 standalone 빌드(라우트 청크 사본 포함)에서
   무시 로그 한 줄, 30분 확인 요청 꼬리표 .papp.e1(sync/off 아님), 설정 카드가 읽는 값(connections API sync.on·held.errorCode ≠ env),
   그리고 S 칸과 같은 동기화 판정(업로드·노트북 파일 수·해시·로컬 삭제 0·동시 진행 ≤ 1)을 본다. */
async function runEnvOff(cell, NEW) {
  const r = { cell };
  const F = await fake();
  try {
    const home = mkdtempSync(join(RUN, 'env-')); const root = join(home, 'root');
    seedSession(root, F.url); writeFileSync(join(root, '.device-id'), 'e2e-main-0001');
    await makeCompany(NEW, home, root);
    const before = eligible(root);
    const log = logFile(cell, 'main');
    const tStart = Date.now();
    const srv = await app(NEW, { home, root, log, extra: { ARGO_SYNC: '0' } });
    for (let t = 0; t < S_OBSERVE_MS && !(r.firstUploadMs ??= null); t += 1000) { await sleep(1000); if (F.objs().length > 0) r.firstUploadMs = Date.now() - tStart; }
    const base = `http://127.0.0.1:${srv.port}`, headers = { cookie: 'argo-device=1' };
    await fetch(`${base}/api/app-gate`, { headers }).catch(() => null); // 화면이 켤 때 부르는 것과 같다 — 이 요청이 30분 확인 요청(꼬리표)을 보낸다
    const conn = await fetch(`${base}/api/companies/${WS}/connections`, { headers }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    while (Date.now() - tStart < S_OBSERVE_MS) await sleep(1000);
    r.sync = conn?.sync ? { on: conn.sync.on, held: conn.sync.held } : conn;
    r.tags = [...new Set(F.tags)];
    r.objects = F.objs().length; r.maxInflightSameCompany = F.maxInflight;
    const mlog = readFileSync(log, 'utf8');
    r.ignoredLogLines = (mlog.match(/\[argo\] sync: 데스크톱 앱은 ARGO_SYNC=0을 따르지 않습니다/g) ?? []).length;
    r.offLogLines = (mlog.match(/\[argo\] sync phase=off err=env/g) ?? []).length;
    await stop(srv);
    const after = eligible(root);
    r.mainFiles = Object.keys(after).length; r.localDeleted = Object.keys(before).filter((k) => !(k in after)).length;
    Object.assign(r, await laptopCheck(NEW, F.url, cell, after));
    r.pass = {
      ...syncedPass(r),
      ignoredLogLine: r.ignoredLogLines === 1 && r.offLogLines === 0,
      tagE1: r.tags.some((t) => /\.papp\.e1$/.test(t)) && !r.tags.some((t) => /^sync\/off\./.test(t)),
      cardValue: r.sync?.on === true && r.sync?.held?.errorCode !== 'env',
    };
  } finally { await F.close(); }
  return r;
}

/* ─── K 계열 — 앱 데이터 폴더를 같이 쓰는 argo CLI ─── */
async function runK(cell, NEW) {
  const r = { cell };
  const F = await fake();
  try {
    const home = mkdtempSync(join(RUN, 'k-'));
    const root = join(home, 'Library', 'Application Support', 'com.beyondworks.argo', 'workspaces'); // src/cli/env.mjs appDataRoot(맥)와 같은 경로 — 앱 서버와 CLI가 같이 쓴다
    const appRoot = process.platform === 'darwin' ? root : join(home, '.local', 'share', 'com.beyondworks.argo', 'workspaces');
    mkdirSync(appRoot, { recursive: true });
    const local = cell === 'K8-local';
    if (!local) seedSession(appRoot, F.url);
    writeFileSync(join(appRoot, '.device-id'), 'e2e-main-0001');
    await makeCompany(NEW, home, appRoot, local ? null : UID);
    if (local) { mkdirSync(join(home, '.argo'), { recursive: true }); writeFileSync(join(home, '.argo', 'cli.json'), JSON.stringify({ mode: 'local' })); }
    const before = eligible(appRoot);
    const ws = join(appRoot, WS);
    const timeline = []; const T0 = Date.now();
    const note = (what) => timeline.push({ t: Date.now() - T0, what, lockPid: lockPid(appRoot), objects: F.objs().length });
    const edit = () => writeFileSync(join(ws, 'notes', 'after-switch.md'), '# 전환 뒤 노트\n');
    let a = null, c = null;
    const A = () => app(NEW, { home, root: appRoot, log: logFile(cell, 'app') });
    const C = (args) => cli(NEW, { home, log: logFile(cell, args ? `cli-${args[0]}` : 'cli'), args });
    if (cell === 'K1-cliOnly') { c = C(); await sleep(45_000); note('cli 45s'); r.cliPid = lockPid(appRoot); }
    else if (cell === 'K2-appOnly') { a = await A(); await sleep(45_000); note('app 45s'); }
    else if (cell === 'K3-both') { a = await A(); await sleep(15_000); note('app 15s'); r.tCli = Date.now(); c = C(); await sleep(45_000); note('both 45s'); r.appPid = a.pid; }
    else if (cell === 'K4-cliToApp') { c = C(); await sleep(30_000); note('cli 30s'); r.lockBefore = lockPid(appRoot); a = await A(); await sleep(30_000); note('app+cli 30s'); r.lockAfterSwitch = lockPid(appRoot); r.appPid = a.pid; edit(); await sleep(20_000); note('edit'); }
    else if (cell === 'K5-appToCli') { a = await A(); await sleep(15_000); c = C(); await sleep(20_000); note('both 20s'); r.lockBefore = lockPid(appRoot); r.appPid = a.pid; await stop(a); a = null; await sleep(20_000); note('cli 20s'); r.lockAfterSwitch = lockPid(appRoot); edit(); await sleep(20_000); note('edit'); }
    else if (cell === 'K6a-cliKilled') { c = C(); await sleep(30_000); note('cli 30s'); r.lockBefore = lockPid(appRoot); await stop(c, 'SIGKILL'); c = null; note('terminal SIGKILL'); a = await A(); await sleep(30_000); note('app 30s'); r.lockAfterSwitch = lockPid(appRoot); r.appPid = a.pid; edit(); await sleep(20_000); note('edit'); }
    else if (cell === 'K6b-cliKill9') { c = C(); await sleep(30_000); note('cli 30s'); r.lockBefore = lockPid(appRoot); try { process.kill(r.lockBefore, 'SIGKILL'); } catch { /* */ } await sleep(1000); r.lockLeftByDead = lockPid(appRoot); note('node SIGKILL'); a = await A(); await sleep(30_000); note('app 30s'); r.lockAfterSwitch = lockPid(appRoot); r.appPid = a.pid; edit(); await sleep(20_000); note('edit'); }
    else if (cell === 'K8-local') { c = C(); await sleep(30_000); note('local cli 30s'); }
    else if (cell === 'K9-oneShot') { const p = C(['status']); await new Promise((res) => { p.on('exit', res); setTimeout(res, 30_000); }); await sleep(5_000); note('status done'); }
    r.reqPerMin = F.rpm(30_000);
    r.timeline = timeline; r.tags = [...new Set(F.tags)];
    r.uploads = F.ups(); r.objects = F.objs().length; r.storageHits = F.hits.filter((h) => h.k.includes('/storage/')).length; r.totalHits = F.hits.length;
    r.uploadsAfterCliStart = r.tCli ? F.ups(r.tCli) : null;
    r.maxInflightSameCompany = F.maxInflight;
    let cl = ''; try { cl = readFileSync(join(home, '.argo', 'cli.log'), 'utf8'); } catch { /* 없음 */ }
    r.cliPhases = grepAll(cl, /sync phase=[\w-]+ err=[\w-]+/g);
    if (c) await stop(c); if (a) await stop(a); await sleep(500);
    r.lockAfterExit = lockPid(appRoot);
    const after = eligible(appRoot);
    r.mainFiles = Object.keys(after).length; r.localDeleted = Object.keys(before).filter((k) => !(k in after)).length;
    if (!local && cell !== 'K9-oneShot') Object.assign(r, await laptopCheck(NEW, F.url, cell, after));
    const synced = () => syncedPass(r);
    const edited = () => ({ editUploaded: F.objs().some((k) => k.endsWith('/notes/after-switch.md')) });
    r.pass = {
      'K1-cliOnly': () => ({ ...synced(), cliSynced: r.cliPhases.some((p) => /phase=idle/.test(p)) }),
      'K2-appOnly': () => synced(),
      'K3-both': () => ({ ...synced(), cliYielded: r.cliPhases.some((p) => /phase=yield/.test(p)), noCliUploads: r.uploadsAfterCliStart === 0, lockStayedApp: r.timeline.every((x) => x.lockPid === r.appPid) }),
      'K4-cliToApp': () => ({ ...synced(), ...edited(), handedToApp: r.lockAfterSwitch === r.appPid && r.lockBefore !== r.appPid }),
      'K5-appToCli': () => ({ ...synced(), ...edited(), handedToCli: r.lockBefore === r.appPid && !!r.lockAfterSwitch && r.lockAfterSwitch !== r.appPid }),
      'K6a-cliKilled': () => ({ ...synced(), ...edited(), appTookOver: r.lockAfterSwitch === r.appPid }),
      'K6b-cliKill9': () => ({ ...synced(), ...edited(), deadLockLeft: r.lockLeftByDead === r.lockBefore, appTookOver: r.lockAfterSwitch === r.appPid }),
      'K8-local': () => ({ noRequests: r.totalHits === 0, noLocalDelete: r.localDeleted === 0 }),
      'K9-oneShot': () => ({ noSyncRequests: r.storageHits === 0, noLocalDelete: r.localDeleted === 0 }),
    }[cell]();
  } finally { await F.close(); }
  return r;
}

/* ─── 실행 ─── */
const t0 = Date.now();
let NEW, OLD;
const results = [];
let exitCode = 0;
try {
  NEW = prepare(NEW_SPEC, 'new');
  OLD = CELLS.some((c) => c.startsWith('S-')) ? prepare(OLD_SPEC, 'old') : null;
  for (const cell of CELLS) {
    const s = Date.now();
    let r;
    // K7(정상 종료 해제)·K10(꼬리표)은 K1(CLI 단독)과 같은 실행을 다른 기준으로 본다 — K1을 돌렸으면 그 측정을 쓴다(없으면 K1을 돌린다)
    const derive = { 'K7-exit': (x) => ({ ...syncedPass(x), lockReleasedOnExit: x.lockAfterExit === null }), 'K10-tag': (x) => ({ ...syncedPass(x), cliTagged: x.tags.some((t) => /\.pcli$/.test(t)), noOffTag: !x.tags.some((t) => /^sync\/off\./.test(t)) }) };
    try {
      if (derive[cell]) { const base = results.find((x) => x.cell === 'K1-cliOnly' && !x.error) ?? await runK('K1-cliOnly', NEW); r = { ...base, cell, from: 'K1-cliOnly', pass: derive[cell](base) }; }
      else r = cell === 'S-envOff' ? await runEnvOff(cell, NEW) : cell.startsWith('S-') ? await runS(cell, NEW, OLD) : await runK(cell, NEW);
    }
    catch (e) { r = { cell, error: String(e?.stack || e).slice(0, 800), pass: { ran: false } }; }
    r.PASS = Object.values(r.pass).every(Boolean); r.seconds = Math.round((Date.now() - s) / 1000);
    writeFileSync(join(OUT, `${cell}.json`), JSON.stringify(r, null, 2));
    console.log(`[e2e] ${cell} ${r.PASS ? 'PASS' : 'FAIL'} ${JSON.stringify(r.pass)} objects=${r.objects ?? '-'} main=${r.mainFiles ?? '-'} laptop=${r.laptopFiles ?? '-'} rpm=${r.reqPerMin ?? '-'} (${r.seconds}s)`);
    results.push(r);
  }
  // 요청 수 비증가 — 정상 상태 칸의 분당 요청이 대조(S-control) 대비 늘지 않았다(대조 × 1.5 또는 +5 이내). 대조를 안 돌렸으면 판정하지 않는다.
  const ctl = results.find((r) => r.cell === 'S-control');
  if (ctl?.reqPerMin != null) for (const r of results.filter((x) => ['S-creds', 'S-guest', 'S-future', 'S-oldEnded', 'S-allEnded', 'S-sleep', 'S-sleepctl', 'K1-cliOnly', 'K2-appOnly', 'K3-both'].includes(x.cell) && x.reqPerMin != null)) {
    r.pass.noMoreRequests = r.reqPerMin <= Math.max(ctl.reqPerMin * 1.5, ctl.reqPerMin + 5);
    r.PASS = Object.values(r.pass).every(Boolean); writeFileSync(join(OUT, `${r.cell}.json`), JSON.stringify(r, null, 2));
  }
} catch (e) { console.error(`[e2e] 중단: ${String(e?.message || e)}`); exitCode = 2; }
cleanup();
await sleep(500);
// 이 실행의 폴더를 가리키는 프로세스가 남지 않았는지(다른 세션·상주 서버는 보지 않는다 — 이 실행의 임시 폴더 이름으로만 찾는다)
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const left = [...new Set([...everPids.filter(alive), ...spawnSync('pgrep', ['-f', RUN], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number)])].filter((p) => p && p !== process.pid); // 띄운 pid 전부 + 이 실행 폴더를 인자로 가진 프로세스
const failed = results.filter((r) => !r.PASS).map((r) => r.cell);
const summary = { new: NEW?.label ?? NEW_SPEC, old: OLD?.label ?? (CELLS.some((c) => c.startsWith('S-')) ? OLD_SPEC : null), cells: results.length, pass: results.length - failed.length, failed, leftProcesses: left.length, out: OUT, minutes: Math.round((Date.now() - t0) / 60_000) };
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ ...summary, results: results.map((r) => ({ cell: r.cell, PASS: r.PASS, pass: r.pass })) }, null, 2));
if (left.length) exitCode = exitCode || 1;
console.log(`e2e-sync-devices: ${summary.pass}/${summary.cells} PASS new=${summary.new} old=${summary.old ?? '-'}${failed.length ? ` FAIL=${failed.join(',')}` : ''} 남은 프로세스=${left.length} ${summary.minutes}분 결과=${OUT}`);
process.exit(exitCode || (failed.length ? 1 : 0));
