// 다른 기기 없이 혼자 쓰는 기기(일반)가 긴 첫 동기화를 하는 동안에도 실행 담당이 꺼지지 않는다 — 배포본과 같아야 한다.
// D 3차 검수: 리스 갱신이 파일 동기화 주기 안에 있고 담당 판정이 '리스를 TTL(120초) 안에 다시 썼는가'를 봐서, 파일 400개를 올리는 첫 주기(약 3분)
// 동안 120초가 지나면 담당이 꺼졌다(공백 55초, 배포본 0). 리스는 이제 동기화 주기와 따로 돈다. 주기가 TTL보다 길어야 재현돼 오래 걸리므로 파일을 따로 둔다
// (node --test는 파일 단위로 나란히 돈다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, spawnLeaseChild } from './helpers/sync-child.mjs';

const LEASE_PATH = '/storage/v1/object/companies/u1/_device-lease.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakes = []; const kids = [];
after(async () => { for (const k of kids) await k.kill(); for (const f of fakes) await f.close(); });

test('혼자 쓰는 기기가 리스 TTL(120초)보다 긴 첫 동기화(파일 300개를 하나에 0.5초씩)를 하는 동안 실행 담당이 한 번도 꺼지지 않는다', { timeout: 260_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-single-longsync-'));
  seedRoot(root, { url: fake.url });
  for (let i = 0; i < 300; i++) writeFileSync(join(root, 'co-1234', `f${i}.md`), `file ${i}\n`.repeat(20));
  fake.fault = (req, path) => (req.method === 'POST' && path.startsWith('/storage/v1/object/') && path !== LEASE_PATH ? 500 : null); // 느린 회선 — 파일 하나 올리는 데 0.5초
  const mac = spawnLeaseChild({ root, name: 'mac', intervalMs: 200 }); kids.push(mac); // 운영 주기(8초)·TTL(120초) 그대로
  const until = Date.now() + 20_000;
  while (!(mac.last()?.proc && mac.last()?.cloud) && Date.now() < until) await sleep(100);
  const onAt = mac.samples.find((x) => x.proc && x.cloud)?.t;
  assert.ok(onAt, `혼자 쓰는 기기는 담당이 된다 ${mac.err.slice(-300)}`);
  await sleep(175_000);
  const uploads = fake.hits.filter((h) => h.k.startsWith('POST /storage/v1/object/companies/u1/co-1234/')).length;
  assert.ok(uploads >= 240 && uploads < 300 + 10, `재현 조건: 첫 동기화 주기가 TTL보다 길다 — 175초 동안 파일 올리기 ${uploads}번`);
  const off = mac.samples.filter((x) => x.t > onAt && !(x.proc && x.cloud));
  assert.equal(off.length, 0, `긴 동기화 중 담당이 꺼졌다 — 처음 꺼진 때 ${((off[0]?.t ?? onAt) - onAt) / 1000}초, 꺼진 표본 ${off.length}개(0.2초 간격)`);
  await mac.kill();
});
