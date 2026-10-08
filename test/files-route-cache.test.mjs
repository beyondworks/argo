// files API 캐시 — 같은 경로를 에이전트가 덮어쓰면("시안 수정해줘") 새 답 그림·크게 보기·새로고침·데스크톱 저장이 하루 동안 옛 그림이던 결함
// (IMG 1차 검수 MEDIUM). 격리 실측(2026-10-09, :3497): 디스크 99B로 덮어쓴 뒤 새 답 그림 naturalWidth 256(옛 그림), 기본 fetch 759B, 새로고침 뒤도 256.
// 응답이 cache-control: private, max-age=86400 + ETag 없음이라 브라우저가 24시간 서버에 다시 묻지 않았다.
// 여기서는 실제 라우트 GET을 임시 vault로 호출해 **응답 행동**(헤더·304·덮어쓴 뒤 새 바이트)을 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-files-cache-')); // 워크스페이스 임포트보다 먼저
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key]; // 인증 꺼짐 — 로컬 1인 모드(가드 통과)

const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url)); // next/headers ESM 확장자 해석(api-error-lang 관례)
const { createCompany, paths } = await import('../src/workspace.mjs');
const { GET } = await import('../app/api/companies/[ws]/files/route.js');
const ws = 'files-cache';
await createCompany(ws, '캐시', 'owner', null, 'ko');
const REL = 'projects/20261008_시안/시안.png';
const abs = join(paths(ws).vault, REL);
await mkdir(join(paths(ws).vault, 'projects', '20261008_시안'), { recursive: true });
const OLD = Buffer.from('old-png-bytes-256x256');
const NEW = Buffer.from('new-32');
await writeFile(abs, OLD);

const get = (rel, { download = false, headers = {} } = {}) => GET(
  new Request(`http://localhost/api/companies/${ws}/files?rel=${encodeURIComponent(rel)}${download ? '&download=1' : ''}`, { headers }),
  { params: Promise.resolve({ ws }) },
);
const bytes = async (res) => Buffer.from(await res.arrayBuffer());

// ─── 인접 행동 핀(origin/main에서도 초록) ───
test('핀: 구역 안 그림은 200·정확한 MIME·원본 바이트, download=1이면 한글 파일명 attachment', async () => {
  await writeFile(abs, OLD);
  const r = await get(REL);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('content-disposition'), null, '미리보기는 인라인');
  assert.deepEqual(await bytes(r), OLD);
  const d = await get(REL, { download: true });
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('시안.png')}`);
  assert.deepEqual(await bytes(d), OLD);
});
test('핀: 구역 밖·탈출은 400, 없는 파일은 404', async () => {
  assert.equal((await get('notes/a.png')).status, 400);
  assert.equal((await get('projects/../company.json')).status, 400);
  assert.equal((await get('projects/x/없음.png')).status, 404);
});

// ─── 새 동작(origin/main에서 빨강) ───
test('캐시: 매번 재확인(no-cache) + ETag — 하루짜리 max-age로 옛 그림을 붙잡지 않는다', async () => {
  await writeFile(abs, OLD);
  const r = await get(REL);
  const cc = r.headers.get('cache-control') ?? '';
  assert.match(cc, /\bno-cache\b/, `cache-control: ${cc}`);
  assert.match(cc, /\bprivate\b/, '공유 캐시 금지는 그대로');
  assert.doesNotMatch(cc, /max-age=[1-9]/, '신선 기간이 있으면 브라우저가 서버에 다시 묻지 않는다');
  assert.match(r.headers.get('etag') ?? '', /^"[^"]+"$/, 'ETag(강한 비교)');
  assert.equal((await get(REL, { download: true })).headers.get('etag'), r.headers.get('etag'), '저장 응답도 같은 ETag');
});
test('캐시: If-None-Match가 같으면 304(본문 없음) — W/·쉼표 목록·* 표기도', async () => {
  await writeFile(abs, OLD);
  const etag = (await get(REL)).headers.get('etag');
  for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
    const r = await get(REL, { headers: { 'if-none-match': inm } });
    assert.equal(r.status, 304, `If-None-Match: ${inm}`);
    assert.equal(r.headers.get('etag'), etag);
    assert.match(r.headers.get('cache-control') ?? '', /no-cache/);
    assert.equal((await bytes(r)).length, 0, '304는 본문 없음');
  }
  assert.equal((await get(REL, { headers: { 'if-none-match': '"other"' } })).status, 200, '다른 ETag는 200');
});
test('캐시: 같은 경로를 덮어쓰면(시안 수정) ETag가 바뀌고, 옛 ETag로 물어도 새 바이트가 온다', async () => {
  await writeFile(abs, OLD);
  const before = await get(REL);
  const oldTag = before.headers.get('etag');
  assert.deepEqual(await bytes(before), OLD);
  await writeFile(abs, NEW);
  const after = await get(REL, { headers: { 'if-none-match': oldTag } });
  assert.equal(after.status, 200, '옛 사본을 재사용하라고 하지 않는다');
  assert.notEqual(after.headers.get('etag'), oldTag);
  assert.deepEqual(await bytes(after), NEW, '덮어쓴 새 바이트');
  const dl = await get(REL, { download: true, headers: { 'if-none-match': oldTag } });
  assert.deepEqual(await bytes(dl), NEW, '저장도 새 바이트');
});
