// 리스 GET만 오래 실패하는 하네스(PR #1197 마지막 재검수 I-A) — 새 판 B(실제 코드)가 살아 있는 혼자 모드 보유자 A의 리스를 한 번 읽은 뒤,
// 리스 GET만 STALE_SEC초 동안 실패한다(A는 그동안 리스를 계속 갱신 — B만 못 읽는다). 클레임 목록·GET은 성공. 그 뒤 B의 클레임 판정이 A의 긴 글을 가져가는가.
// 고치기 전: 낡은 holder.ts를 지금 시각과 비교해 A를 '보유자 아님'으로 보고 120초 TTL로 가져갔다(두 기기 겹침).
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mock } from 'node:test';
const SRC = process.env.SRC || fileURLToPath(new URL('../..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'rv1197s-'));
process.env.ARGO_ROOT = root; process.env.ARGO_SYNC = '1';
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-rv', email: '' } }), { mode: 0o600 });
const sync = await import(pathToFileURL(join(SRC, 'src/sync.mjs')).href);
const OWNER = 'owner-rv'; const TOK = 'shared-token'; const Adev = 'A-Mac-11112222';
const CK = `${OWNER}/.tg-claims/${sync.tokenClaimHash(TOK)}.json`; const LK = `${OWNER}/_device-lease.json`;
const objs = new Map(); let failLease = false;
const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
const bucket = {
  async download(key) { const k = String(key).split('?')[0]; if (k === LK && failLease) return { data: null, error: { name: 'StorageApiError', message: 'upstream 503', status: 503, statusCode: '503' } }; const b = objs.get(k); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
  async upload(key, blob) { if (String(key) === LK && failLease) return { data: null, error: { name: 'StorageApiError', message: 'upstream 503', status: 503, statusCode: '503' } }; objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
  async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
  async list(prefix) { const out = []; for (const [k, b] of objs) if (k.startsWith(`${prefix}/`)) out.push({ name: k.slice(prefix.length + 1), metadata: { eTag: `"${createHash('md5').update(b).digest('hex')}"` } }); return { data: out, error: null }; },
};
sync._setSyncClientForTest({ storage: { from: () => bucket } });
const t0 = Date.now();
mock.timers.enable({ apis: ['Date'], now: t0 });
const putA = () => objs.set(LK, Buffer.from(JSON.stringify({ deviceId: Adev, token: 'ta', ts: Date.now() - 30_000 })));
putA(); // A의 리스 글(30초 전 = 살아 있음)
objs.set(CK, Buffer.from(JSON.stringify({ deviceId: Adev, nonce: 'a', ts: t0 - 5 * 60_000, lease: true, ttl: 20 * 60_000 })));
sync.setClaimTokens([TOK]);
await sync.renewLease(OWNER, { runnerUsable: true }); // B가 A의 리스를 한 번 읽음(holder=A, holderReadAt=t0)
failLease = true; // 이제 B의 리스 GET만 실패
const stale = Number(process.env.STALE_SEC ?? 70) * 1000;
mock.timers.tick(stale); putA(); // A는 계속 갱신(B는 못 읽음)
await sync.renewLease(OWNER, { runnerUsable: true }); // 실패 — holder는 낡은 그대로
await sync.renewTokenClaims(OWNER, { force: true });
const doc = JSON.parse(objs.get(CK).toString());
mock.timers.reset();
process.stdout.write('\n@@' + JSON.stringify({ staleSec: stale / 1000, bOwnership: sync.tokenOwnership(TOK), claimNowBy: doc.deviceId === Adev ? 'A' : 'B' }) + '\n');
rmSync(root, { recursive: true, force: true });
process.exit(0);
