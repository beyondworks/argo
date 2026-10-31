// 첫 리스 읽기 실패 하네스(PR #1197 엄격 검수의 하네스를 그대로 옮김) — 새 판 B(실제 코드)가 켜지는 첫 판정에서 리스 GET 한 번이 실패(5xx)하면, 살아 있는 혼자 모드 보유자 A의 긴 클레임을 가져가는가.
// A: 리스 글 30초 전(살아 있음), 클레임 { lease:true, ttl:20분 } 5분 전. B의 첫 리스 읽기만 실패, 클레임 목록·GET은 성공.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SRC = process.env.SRC || new URL('../..', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'rv1197b-'));
process.env.ARGO_ROOT = root; process.env.ARGO_SYNC = '1';
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-rv', email: '' } }), { mode: 0o600 });
const sync = await import(join(SRC, 'src/sync.mjs'));
const OWNER = 'owner-rv'; const TOK = 'shared-token'; const Adev = 'A-Mac-11112222';
const CK = `${OWNER}/.tg-claims/${sync.tokenClaimHash(TOK)}.json`; const LK = `${OWNER}/_device-lease.json`;
const objs = new Map(); let failLease = Number(process.env.FAIL_LEASE ?? 1);
const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
const bucket = {
  async download(key) { const k = String(key).split('?')[0]; if (k === LK && failLease > 0) { failLease -= 1; return { data: null, error: { name: 'StorageApiError', message: 'upstream 503', status: 503, statusCode: '503' } }; } const b = objs.get(k); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
  async upload(key, blob) { objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
  async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
  async list(prefix) { const out = []; for (const [k, b] of objs) if (k.startsWith(`${prefix}/`)) out.push({ name: k.slice(prefix.length + 1), metadata: { eTag: `"${createHash('md5').update(b).digest('hex')}"` } }); return { data: out, error: null }; },
};
sync._setSyncClientForTest({ storage: { from: () => bucket } });
const now = Date.now();
objs.set(LK, Buffer.from(JSON.stringify({ deviceId: Adev, token: 'ta', ts: now - 30_000 })));
const aDoc = process.env.A_DOC === 'classic' ? { deviceId: Adev, nonce: 'a', ts: now - 70_000 } : { deviceId: Adev, nonce: 'a', ts: now - 5 * 60_000, lease: true, ttl: 20 * 60_000 };
objs.set(CK, Buffer.from(JSON.stringify(aDoc)));
sync.setClaimTokens([TOK]);
await sync.renewLease(OWNER, { runnerUsable: true }); // leaseTick 첫 줄 — 리스 읽기 실패
await sync.renewTokenClaims(OWNER); // leaseTick 둘째 줄 — 첫 판정(레이트리밋 없음)
const doc = JSON.parse(objs.get(CK).toString());
process.stdout.write('\n@@' + JSON.stringify({ aDoc: process.env.A_DOC ?? 'solo', leaseReadFailed: Number(process.env.FAIL_LEASE ?? 1) > 0, bOwnership: sync.tokenOwnership(TOK), claimNowBy: doc.deviceId === Adev ? 'A' : 'B' }) + '\n');
rmSync(root, { recursive: true, force: true });
process.exit(0);
