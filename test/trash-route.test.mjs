// 2차 분리 검수 M3(2026-10-05): 보관함 복구가 이미 사라진 항목에서 "복구하지 못했습니다 — ENOENT: no such file or directory, open '/private/tmp/…/chats/.trash/….json'"(절대 경로 노출)을 보였고,
// 항목은 목록에 남아 눌러도 같은 오류가 반복됐다(trash/route.js 모든 예외를 400 + e.message로 내림).
// 잠그는 행동(실제 라우트): ① 항목이 없으면 404 + errorCode trash_item_gone(경로·시스템 원문 없음) ② 그 밖의 실패는 500 + trash_failed(원문 없음) ③ 정상 복구·영구 삭제는 그대로 ④ 화면 판정(trashFailKind)은 gone일 때만 목록을 다시 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-trashroute-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true;
const { createCompany, paths } = await import('../src/workspace.mjs');
const route = await import('../app/api/companies/[ws]/trash/route.js');
const { API_MSG } = await import('../app/apimsg.mjs');
const { trashFailKind } = await import('../app/c/[ws]/settings/trash-fail.mjs');

const WS = 'trash-co';
await createCompany(WS, '보관함 검증', 'owner', null, 'ko');
const call = (method, { body, query = '', lang = 'ko' } = {}) => route[method](new Request(`http://localhost/api/companies/${WS}/trash${query}`, {
  method, headers: { 'content-type': 'application/json', cookie: `argo-lang=${lang}` }, ...(body ? { body: JSON.stringify(body) } : {}),
}), { params: Promise.resolve({ ws: WS }) });

test('이미 사라진 항목의 복구 — 404 trash_item_gone, 절대 경로·시스템 원문이 응답에 없다', async () => {
  const res = await call('POST', { body: { id: 'nova-1700000000000.json' } }); // 라우트 실호출 — 표시 언어는 요청 쿠키(요청 스코프 밖이라 ko 폴백), en 문구는 api-error-lang 기대표가 잠근다
  const text = await res.text(); const body = JSON.parse(text);
  assert.equal(res.status, 404);
  assert.equal(body.errorCode, 'trash_item_gone');
  assert.equal(body.error, API_MSG.trash_item_gone.ko);
  assert.ok(!/ENOENT|no such file|\/private|\/tmp|\.trash/.test(text), `경로·시스템 원문이 새지 않는다: ${text}`);
  assert.equal(API_MSG.trash_item_gone.status, 404);
});

test('잘못된 id·id 없음도 원문 없이 — 항목이 없는 것과 같다(404) / 입력 누락(400)', async () => {
  const bad = await call('POST', { body: { id: '../../etc/passwd' } });
  assert.equal(bad.status, 404); assert.equal((await bad.json()).errorCode, 'trash_item_gone');
  const none = await call('POST', { body: {} });
  assert.equal(none.status, 400); assert.equal((await none.json()).errorCode, 'trash_bad_request');
});

test('영구 삭제·목록의 예기치 않은 실패는 500 trash_failed — 원문 없음', async () => {
  const chats = paths(WS).chats;
  await mkdir(chats, { recursive: true });
  await writeFile(join(chats, '.trash'), 'x'); // 폴더 자리에 파일 — 목록·삭제가 ENOTDIR 등으로 실패하게
  const list = await call('GET'); const t1 = await list.text();
  const del = await call('DELETE', { query: '?id=nova-1700000000001.json' }); const t2 = await del.text();
  for (const [res, text] of [[list, t1], [del, t2]]) {
    if (res.status === 200) continue; // 목록은 .trash가 파일이면 빈 목록으로 처리할 수도 있다 — 그 경우는 실패가 아니다
    assert.equal(res.status, 500); assert.equal(JSON.parse(text).errorCode, 'trash_failed');
    assert.ok(!/ENOTDIR|ENOENT|\/private|\/tmp|\.trash/.test(text), `원문이 새지 않는다: ${text}`);
  }
});

test('정상 복구는 그대로 — 보관함 항목이 .archive로 돌아가고 200', async () => {
  const chats = paths(WS).chats;
  const { rm } = await import('node:fs/promises'); await rm(join(chats, '.trash'), { force: true });
  await mkdir(join(chats, '.trash'), { recursive: true });
  await writeFile(join(chats, '.trash', 'nova-1700000000002.json'), JSON.stringify({ messages: [{ who: 'user', text: '안녕' }] }));
  const res = await call('POST', { body: { id: 'nova-1700000000002.json' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await readdir(join(chats, '.trash')), []);
  assert.ok((await readdir(join(chats, '.archive'))).includes('nova-1700000000002.json'));
});

test('화면 판정 — 항목이 사라졌으면(gone) 목록을 다시 읽고, 그 밖의 실패는 목록을 그대로 둔다', () => {
  assert.equal(trashFailKind(Object.assign(new Error('x'), { data: { errorCode: 'trash_item_gone' }, status: 404 })), 'gone');
  assert.equal(trashFailKind(Object.assign(new Error('x'), { data: { errorCode: 'trash_failed' }, status: 500 })), 'failed');
  assert.equal(trashFailKind(Object.assign(new Error('x'), { status: 404 })), 'failed', '코드 없는 404(프록시 등)는 지워졌다고 단정하지 않는다');
  assert.equal(trashFailKind(new TypeError('Load failed')), 'failed'); assert.equal(trashFailKind(null), 'failed');
});
