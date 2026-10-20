// 게이트웨이 플래그 핀 — 실제 게이트웨이(+동기화)를 자식 프로세스로 띄워 가짜 Supabase에 오는 요청으로 판정한다(lease-standby-e2e와 같은 방식).
// ① 플래그 없음(배포본과 같은 기본): 옛 메신저 브리지가 돈다(msgr_crews 조회 > 0), 새 링크 요청은 0.
// ② ARGO_MSGR_LEGACY=off: 옛 브리지 조회 0.
// ③ ARGO_AGENT_LINK=1: 새 링크가 runner 기기 등록을 시도하고, 옛 브리지는 그대로 돈다(두 플래그는 따로다).
// ④ ARGO_AGENT_LINK=1 + 확정 무료 계정: 새 링크도 옛 브리지도 클라우드 요청 0(메신저 Pro 전용, msgrCloud 판정).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, childEnv, srcUrl } from './helpers/sync-child.mjs';

const fakes = []; const kids = [];
after(async () => { for (const k of kids) await k.kill(); for (const f of fakes) await f.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MSGR_POLL = 'GET /rest/v1/msgr_crews';
const LINK_REG = 'POST /rest/v1/rpc/msgr2_device_register';
const LINK_ANY = /\/rpc\/msgr2_/;

async function device(fake) {
  const root = await mkdtemp(join(tmpdir(), 'argo-link-flags-'));
  seedRoot(root, { url: fake.url });
  writeFileSync(join(root, 'co-1234', 'company.json'), JSON.stringify({ id: 'co-1234', name: 'Fixture', ownerId: 'u1', msgr: { enabled: true } }));
  return root;
}

function gatewayChild(root, env) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const gw = await import(${JSON.stringify(srcUrl('gateway.mjs'))});
sync.ensureSync(); gw.ensureGateway();`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: childEnv(root, { ARGO_SYNC_CYCLE_MS: '1000', ARGO_AGENT_LINK: '', ARGO_MSGR_LEGACY: '', ...env }), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; let exited = false;
  p.stderr.on('data', (c) => { err += c; });
  const done = new Promise((r) => p.on('exit', () => { exited = true; r(); }));
  const k = { get err() { return err; }, kill: async () => { if (!exited) { p.kill('SIGKILL'); await done; } } };
  kids.push(k); return k;
}

const countRe = (fake, re) => fake.hits.filter((h) => re.test(h.k)).length;

test('게이트웨이 플래그: 기본(핀)·옛 브리지 끔·새 링크 켬', { timeout: 120_000 }, async () => {
  const scenes = [
    { label: '기본', env: {}, legacy: true, link: false },
    { label: 'ARGO_MSGR_LEGACY=off', env: { ARGO_MSGR_LEGACY: 'off' }, legacy: false, link: false },
    { label: 'ARGO_AGENT_LINK=1', env: { ARGO_AGENT_LINK: '1' }, legacy: true, link: true },
    { label: 'ARGO_AGENT_LINK=1 + 무료', env: { ARGO_AGENT_LINK: '1' }, plan: 'free', legacy: false, link: false },
  ];
  const runs = await Promise.all(scenes.map(async (s) => {
    const fake = await startFakeSupabase({ plan: s.plan ?? 'pro' }); fakes.push(fake);
    const kid = gatewayChild(await device(fake), s.env);
    await sleep(16_000); // 게이트웨이 첫 확인 + 브리지 첫 조회(15초 주기)보다 길게
    await kid.kill();
    return { s, fake, kid };
  }));
  for (const { s, fake, kid } of runs) {
    const polls = fake.count(MSGR_POLL);
    const reg = fake.count(LINK_REG);
    if (s.legacy) assert.ok(polls > 0, `${s.label}: 옛 브리지가 돌아야 한다 — msgr_crews 조회 ${polls} ${kid.err.slice(-300)}`);
    else assert.equal(polls, 0, `${s.label}: 옛 브리지가 돌았다 — 조회 ${polls}`);
    if (s.link) assert.ok(reg >= 1, `${s.label}: 새 링크가 기기 등록을 시도해야 한다 — ${reg} ${kid.err.slice(-300)}`);
    else {
      assert.equal(reg, 0, `${s.label}: 플래그 없이 새 링크 요청 ${reg}`);
      assert.equal(countRe(fake, LINK_ANY), 0, `${s.label}: msgr2_ 요청이 있다`);
    }
  }
});
