// 임시 재현 스크립트 — 윈도우 CI에서 crewmail 선점 rename의 상호배제가 깨지는지 실측.
// (조사용 — PR에 포함하지 않는다)
import { mkdtemp, rm, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.env.REPRO_N ?? 2000);

// ── 실험 1: 프리미티브 — 같은 소스를 두 주체가 동시에 rename ──
async function primitive() {
  const dir = await mkdtemp(join(tmpdir(), 'repro-prim-'));
  const dist = { 0: 0, 1: 0, 2: 0 };
  const codes = {};
  for (let i = 0; i < N; i++) {
    const src = join(dir, `m${i}.json`);
    const dst = `${src}.claimed`;
    await writeFile(src, '{"x":1}');
    const rs = await Promise.allSettled([rename(src, dst), rename(src, dst)]);
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    dist[ok] += 1;
    for (const r of rs) if (r.status === 'rejected') codes[r.reason.code] = (codes[r.reason.code] ?? 0) + 1;
    if (ok === 2) console.log(`[prim] i=${i} 두 rename 모두 성공!`);
    await rm(dst, { force: true }); await rm(src, { force: true });
  }
  console.log('[prim] dist:', dist, 'reject codes:', codes);
  await rm(dir, { recursive: true, force: true });
  return dist[2];
}

// ── 실험 2: 실제 경로 — deliverCrewMail 두 개 동시 (테스트와 동일, 단 sleep 0) ──
async function realpath() {
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'repro-real-'));
  const { paths } = await import('./src/workspace.mjs');
  const mod = await import('./src/crewmail.mjs');
  const WS = 'repro-ws';
  await mkdir(paths(WS).root, { recursive: true });
  await writeFile(paths(WS).company, JSON.stringify({ id: WS, name: 'r' }));
  let doubles = 0;
  for (let i = 0; i < Math.min(N, 500); i++) {
    await mod.sendCrewMail(WS, { from: 'a', fromName: 'A', to: 'race', message: `r${i}` });
    let calls = 0;
    const run = () => mod.deliverCrewMail(WS, async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); });
    await Promise.all([run(), run()]);
    if (calls !== 1) { doubles += 1; console.log(`[real] i=${i} calls=${calls}`); }
    // 잔재 청소 — 다음 회차 오염 방지
    await rm(join(paths(WS).root, 'mail'), { recursive: true, force: true });
  }
  console.log(`[real] doubles=${doubles}/${Math.min(N, 500)}`);
  await rm(process.env.ARGO_ROOT, { recursive: true, force: true });
  return doubles;
}

const p = await primitive();
const r = await realpath();
console.log(`RESULT primitive-double=${p} realpath-double=${r}`);
