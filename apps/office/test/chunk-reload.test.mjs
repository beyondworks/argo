// 화면 파일 못 받음 → 한 번만 새로 불러오기. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isChunkError, reloadOnce } from '../src/core/chunk-reload.js';

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

// 이유(통합 검수 10/1): 배포로 파일 이름이 바뀐 뒤 옛 탭에서 화면을 열면 지연 로드가 실패해 앱 전체가 하얘졌다. 브라우저마다 문구가 다르다.
test('화면 파일 실패만 알아본다', () => {
  assert.ok(isChunkError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/Calendar-abc.js'))); // Chrome
  assert.ok(isChunkError(new TypeError('error loading dynamically imported module'))); // Firefox
  assert.ok(isChunkError(new TypeError('Importing a module script failed.'))); // Safari
  assert.ok(isChunkError(new Error('Unable to preload CSS for /assets/x.css'))); // Vite
  assert.ok(!isChunkError(new TypeError("Cannot read properties of undefined (reading 'id')"))); // 화면 코드 오류는 새로 불러와도 같다
  assert.ok(!isChunkError(null));
});

// 이유(통합 검수 10/1 "sessionStorage로 막아 절대 반복하지 않게"): 새로 불러와도 또 실패하면(서버가 계속 504) 무한 새로 고침이 된다.
test('한 번만 새로 불러온다 — 1분 안 두 번째 실패는 안내로', () => {
  const s = store(), err = new TypeError('Failed to fetch dynamically imported module: x');
  assert.equal(reloadOnce(err, s, 1_000), true);
  assert.equal(reloadOnce(err, s, 5_000), false);
  assert.equal(reloadOnce(err, s, 70_000), true); // 한참 뒤 다른 배포면 다시 한 번
  assert.equal(reloadOnce(new Error('boom'), store(), 1_000), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(reloadOnce(err, broken, 1_000), false); // 저장소를 못 쓰면 자동 새로 고침 없음
});

// 이유: 지연 로드 화면과 늘 그리는 지연 창(공유·맡기기·이력·메일 쓰기)이 실패해도 앱 전체가 사라지지 않는다.
test('지연 로드 자리는 모두 오류 경계 안에 있다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  // Suspense는 Lazy(경계 + Suspense) 한 곳에만 — 나머지 자리는 Lazy를 쓴다
  assert.equal(src.match(/<Suspense[\s>]/g).length, 1);
  assert.match(src, /const Lazy = [^\n]*<Boundary[^>]*><Suspense fallback=\{fallback\}>\{children\}<\/Suspense><\/Boundary>/);
  assert.ok(src.match(/<Lazy[\s>]/g).length >= 6);
  for (const k of ['load.fail', 'load.retry']) assert.match(readFileSync(new URL('../src/core/i18n.js', import.meta.url), 'utf8'), new RegExp(`'${k.replace('.', '\\.')}': \\['[^']+', '[^']+'\\]`));
});
