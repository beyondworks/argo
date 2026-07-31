// 보안 헤더 계약 — 프레임 정책의 완화 범위가 files 라우트 밖으로 번지는 드리프트를 잠근다.
// 배경(PR #210): 채팅 인라인 pdf 미리보기를 위해 files 라우트만 same-origin 프레임을 허용했다.
// 이 예외가 ① 전역(:path*)으로 넓어지거나 ② 전역 뒤 배치가 무너지면(Next headers는 같은 키를
// 뒤 항목이 덮는다) 클릭재킹 방어가 조용히 사라진다 — 반환값을 직접 단언해 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../next.config.mjs';

test('전역은 DENY/none 유지, files 라우트만 SAMEORIGIN/self — 그리고 files가 전역 뒤', async () => {
  const entries = await config.headers();
  const find = (src) => entries.find((e) => e.source === src);
  const header = (e, k) => e.headers.find((h) => h.key === k)?.value;

  const global = find('/:path*');
  assert.equal(header(global, 'X-Frame-Options'), 'DENY');
  assert.match(header(global, 'Content-Security-Policy'), /frame-ancestors 'none'/);

  const files = find('/api/companies/:ws/files');
  assert.equal(header(files, 'X-Frame-Options'), 'SAMEORIGIN');
  assert.match(header(files, 'Content-Security-Policy'), /frame-ancestors 'self'/);

  // 완화는 이 두 헤더뿐 — files 항목에 다른 키가 슬며시 얹히는 것도 드리프트다
  assert.deepEqual(files.headers.map((h) => h.key).sort(), ['Content-Security-Policy', 'X-Frame-Options']);
  // 순서: files(완화)가 전역보다 뒤여야 같은 키를 덮는다
  assert.ok(entries.indexOf(files) > entries.indexOf(global), 'files 완화 항목은 전역 뒤에 있어야 한다');
  // 완화 범위 봉인: SAMEORIGIN을 주는 항목은 files 라우트 하나뿐
  const relaxed = entries.filter((e) => e.headers.some((h) => h.key === 'X-Frame-Options' && h.value !== 'DENY'));
  assert.deepEqual(relaxed.map((e) => e.source), ['/api/companies/:ws/files']);
});
