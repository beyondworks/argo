// 회사 화면의 동기화 오류는 자기 회사 몫만 — 실제 동기화 루프(ensureSync)를 자식 프로세스로 돌려 cycle()의 배선을 잠근다.
// lastError는 기기 전체에 하나라 여러 회사가 실패하면 마지막 회사 것만 남는다. 회사 화면(syncStatusFor)은 회사 결과의 error를 보여야
// 마지막이 아닌 회사·재시도 대기 중인 회사에도 오류가 보이고, 다른 회사(게스트·다른 계정 화면 포함)에는 남의 파일 경로가 안 보인다
// (분리 검수 2차 MEDIUM-1·LOW-1, 2026-10-05). 첫 주기에 throw한 회사도 회사로 등록돼야 그 접두가 남의 화면에 새지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, childEnv, srcUrl } from './helpers/sync-child.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
const meta = (b) => ({ m: 1_790_000_000_000, s: b.length, h: createHash('sha1').update(b).digest('hex').slice(0, 16) });

test('여러 회사가 함께 실패해도 각 회사 화면에는 자기 오류만 — 재시도 대기 중에도 유지, 첫 주기 throw도 남의 화면에 안 샌다', { timeout: 60_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-company-error-'));
  seedRoot(root, { url: fake.url, wsId: 'co-1234' });
  const note = Buffer.from('# remote note\n');
  for (const ws of ['co-1234', 'co-5678']) { // 원격 파일 자리에 로컬 빈 폴더 → 받기(쓰기) 실패
    mkdirSync(join(root, ws, 'vault', 'blocked.md'), { recursive: true });
    writeFileSync(join(root, ws, 'company.json'), JSON.stringify({ id: ws, name: ws, ownerId: 'u1' }));
    fake.store.set(`companies/u1/${ws}/vault/blocked.md`, note);
    fake.store.set(`companies/u1/${ws}/__manifest__.json`, Buffer.from(JSON.stringify({ files: { 'vault/blocked.md': meta(note) } })));
  }
  mkdirSync(join(root, 'co-9999'), { recursive: true }); // 매니페스트 파싱 실패 → syncCompany가 throw(cycle의 catch 경로)
  writeFileSync(join(root, 'co-9999', 'company.json'), JSON.stringify({ id: 'co-9999', name: 'co-9999', ownerId: 'u1' }));
  fake.store.set('companies/u1/co-9999/__manifest__.json', Buffer.from('not json'));

  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
sync.ensureSync();
await new Promise((r) => setTimeout(r, 3000)); // 첫 주기(셋 다 실패) 뒤 재시도 대기 주기를 몇 번 지난다
const pick = (ws) => { const s = sync.syncStatusFor(ws); return { lastError: s.lastError, keys: Object.keys(s.companies), skipped: s.companies[ws]?.skipped ?? null }; };
process.stdout.write('\\n@@' + JSON.stringify({ raw: sync.syncStatus().lastError, a: pick('co-1234'), b: pick('co-5678'), x: pick('co-9999'), none: pick('co-none') }) + '\\n');
process.exit(0);`;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ARGO_SYNC_CYCLE_MS: '500' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { e += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${e.slice(-1500)}`)); }, 30_000);
    p.on('exit', () => { clearTimeout(t); const line = o.split('\n').find((l) => l.startsWith('@@')); line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(`no status\n${o.slice(-1500)}\n${e.slice(-1500)}`)); });
  });

  assert.match(out.raw, /^co-\d{4}: /, `기기 전체 lastError는 마지막으로 실패한 회사 하나 몫이다: ${out.raw}`);
  assert.match(out.a.lastError, /^co-1234: 동기화 파일 1건 실패 \(vault\/blocked\.md: /, '마지막이 아닌 실패 회사도 자기 오류(파일 이름·사유)가 보인다');
  assert.match(out.b.lastError, /^co-5678: 동기화 파일 1건 실패 \(vault\/blocked\.md: /);
  assert.equal(out.a.skipped, 'retry-backoff', '재시도 대기 주기를 지난 뒤의 상태다');
  assert.match(out.x.lastError, /^co-9999: 매니페스트 파싱 실패/, '첫 주기에 throw한 회사도 자기 오류가 보인다');
  assert.deepEqual(out.none, { lastError: '', keys: [], skipped: null }, '동기화 기록이 없는 회사(게스트 화면 등)에는 다른 회사 오류·파일 경로가 안 보인다');
  assert.deepEqual(out.a.keys, ['co-1234'], '회사 화면 상태는 그 회사 것만');
});
