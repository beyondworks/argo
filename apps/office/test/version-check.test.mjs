// 새 버전 안내(유건 10/4) — 열어 둔 탭이 새 배포를 알아채고 "새 버전이 있습니다 · 새로고침"을 띄운다.
// 배포 전부터 열려 있던 탭의 옛 편집기가 새 블록이 든 페이지를 빈 문서로 여는 사고(16차 검수 M3)를 다음 배포부터 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildId } from '../build-id.mjs';
import { versionDue, isNewer } from '../src/core/version-check.js';

// 이유: 앱 안 표시와 dist/version.json이 같은 값이어야 비교가 된다 — 빌드마다 다른 값
test('빌드 표시: 앱 안(define)과 version.json에 같은 값', () => {
  const p = buildId('abc123');
  assert.deepEqual(p.config().define, { __OFFICE_BUILD__: JSON.stringify('abc123') });
  const files = [];
  p.generateBundle.call({ emitFile: (f) => files.push(f) });
  assert.deepEqual(files, [{ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: 'abc123' }) }]);
  assert.notEqual(buildId().config().define.__OFFICE_BUILD__, JSON.stringify(''), '기본값도 빈 값이 아니다');
});

// 이유: 확인은 탭으로 돌아올 때 10분에 한 번까지(정적 파일 하나 — DB 호출 아님), 숨긴 탭은 하지 않는다
test('확인 간격·새 버전 판정', () => {
  assert.equal(versionDue({ now: 600_000, last: 0, hidden: false }), true);
  assert.equal(versionDue({ now: 599_999, last: 0, hidden: false }), false);
  assert.equal(versionDue({ now: 9e9, last: 0, hidden: true }), false);
  assert.equal(isNewer('b', 'a'), true);
  assert.equal(isNewer('a', 'a'), false);
  assert.equal(isNewer('', 'a'), false, '서버 값을 못 읽으면 안내하지 않는다');
  assert.equal(isNewer('b', ''), false, '개발 서버(표시 없음)에서는 안내하지 않는다');
});

// 이유: 서비스 워커는 같은 출처 파일을 캐시 먼저 돌려준다 — version.json까지 캐시하면 늘 옛 값이라 새 버전을 못 알아챈다(주소에 시각을 붙이면 캐시가 쌓인다)
test('서비스 워커는 version.json을 캐시하지 않고 그대로 통과시킨다', () => {
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const handlers = {};
  const self = { addEventListener: (k, f) => { handlers[k] = f; }, skipWaiting() {}, clients: { claim() {} } };
  new Function('self', 'caches', 'location', 'fetch', src)(self, { open: async () => ({ addAll: async () => {}, put: async () => {} }), match: async () => null, keys: async () => [] }, { origin: 'https://office.example' }, async () => ({ clone() { return this; } }));
  const fire = (url) => { let responded = false; handlers.fetch({ request: { method: 'GET', url, mode: 'cors' }, respondWith: () => { responded = true; } }); return responded; };
  assert.equal(fire('https://office.example/version.json?t=1'), false, 'version.json은 서비스 워커가 손대지 않는다');
  assert.equal(fire('https://office.example/assets/app-1.js'), true, '화면 파일은 그대로 캐시한다');
});
