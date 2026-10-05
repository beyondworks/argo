// 빈 원격 회사 복원 루프(운영 실측 2026-10-05, lean-company-kqav) — 행동 테스트: 실제 supabase-js + 가짜 Supabase HTTP + 임시 ARGO_ROOT, 동기화 루프는 자식 프로세스.
// 원격에 봉인된 {"files":{}} 매니페스트(54바이트)만 남은 회사를 색인(argo_sync_index)이 계속 돌려준다. company.json을 받을 수 없어 로컬 회사가 되지 못하고
// 발견 주기(5분)마다 다시 '복원'된다. 복원이면 매니페스트를 무조건 다시 쓰던 조건 때문에 기기 1대가 시간당 매니페스트 GET 24·POST 12(storage.objects 갱신 12)를 냈다.
// 계약(이유: Storage·DB 쓰기는 값이 바뀔 때만 — CLAUDE.md 전송량 절): 아무것도 바꾸지 않은 복원은 매니페스트를 쓰지 않고 재읽기도 하지 않는다.
// 인접 핀: 바꿀 것이 있는 복원(평문 매니페스트 봉인)은 한 번 쓰고 멈추며, 진짜 회사(company.json 있음)는 첫 발견에서 받아 로컬 회사가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, runSyncChild } from './helpers/sync-child.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-emptyrestore-'));
process.env.ARGO_ROOT = ROOT; // 봉인용 secretbox(→ workspace.mjs) 임포트보다 먼저 — 이 프로세스도 실제 데이터 루트를 보지 않게
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret } = await import('../src/secretbox.mjs');

const OWNER = 'u1';
const key = (ws, rel) => `companies/${OWNER}/${ws}/${rel}`;
const meta = (buf) => ({ m: 1000, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });
const EMPTY = Buffer.from(JSON.stringify({ files: {} }));

test('빈 원격 회사 — 발견 주기마다 복원돼도 매니페스트를 다시 쓰지 않는다(쓰기 0·발견 1회에 GET 최대 1)', async () => {
  await useFakeAccountKey(1, OWNER); // 가짜 서버의 account_keys(0x01×32)와 같은 키 — 운영처럼 이미 봉인된 매니페스트를 깐다
  const SHELL = 'lean-company-kqav', PLAIN = 'co-plain', REAL = 'co-real';
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: { companies: ['co-1234', SHELL, PLAIN, REAL] } });
  try {
    seedRoot(ROOT, { url: fake.url, userId: OWNER, wsId: 'co-1234' });
    const shell = sealSecret(EMPTY);
    assert.equal(shell.length, 54, '전제: 운영 매니페스트와 같은 모양(봉인된 빈 목록 54바이트)');
    fake.store.set(key(SHELL, '__manifest__.json'), shell);
    fake.store.set(key(PLAIN, '__manifest__.json'), EMPTY); // 평문 — 이 기기는 봉인해야 하므로 한 번은 써야 한다
    const co = Buffer.from(JSON.stringify({ id: REAL, name: '진짜 회사', ownerId: OWNER }));
    fake.store.set(key(REAL, 'company.json'), co);
    fake.store.set(key(REAL, '__manifest__.json'), sealSecret(Buffer.from(JSON.stringify({ files: { 'company.json': meta(co) } }))));

    await runSyncChild({ root: ROOT, env: { ARGO_SYNC_CYCLE_MS: '100', ARGO_SYNC_DISCOVER_MS: '400' }, waitMs: 4000 });

    const discover = fake.count('POST /rest/v1/rpc/argo_sync_index');
    const M = (ws) => `/storage/v1/object/${key(ws, '__manifest__.json')}`;
    assert.ok(discover >= 2, `발견이 두 번 이상 돌아야 반복을 본다(실제 ${discover})`);
    assert.equal(fake.count(`POST ${M(SHELL)}`), 0, `빈 회사 매니페스트 쓰기 0 — 수정 전엔 발견마다 1회(발견 ${discover})`);
    assert.ok(fake.store.get(key(SHELL, '__manifest__.json')).equals(shell), '원격 매니페스트 바이트가 그대로다');
    const gets = fake.count(`GET ${M(SHELL)}`);
    assert.ok(gets <= discover, `발견 1회에 GET 최대 1회(쓰지 않으니 재읽기도 없다) — GET ${gets} / 발견 ${discover}`);
    // 인접 핀 ①: 바꿀 것이 있는 복원은 쓴다 — 평문을 봉인해 한 번 올리고, 그다음 발견부터는 쓰지 않는다
    assert.equal(fake.count(`POST ${M(PLAIN)}`), 1, '평문 매니페스트는 한 번 봉인해 올린다(그 뒤 반복 쓰기 없음)');
    assert.ok(fake.store.get(key(PLAIN, '__manifest__.json')).subarray(0, 14).equals(Buffer.from('argosecret.v2:')), '봉인본으로 바뀌었다');
    // 인접 핀 ②: 진짜 회사는 첫 발견에서 받아 로컬 회사가 된다
    assert.equal(JSON.parse(readFileSync(join(ROOT, REAL, 'company.json'), 'utf8')).name, '진짜 회사');
  } finally { await fake.close(); }
});
