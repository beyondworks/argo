// 알림함 탭 숫자는 읽지 않은 수(D37, 정비사 P7-4) — 총수면 '모두 읽음' 뒤에도 '나를 부름 4'가 남았다.
// 실측(ego, 픽스처 멘션 4건): main 모두 읽음 뒤 '나를 부름4' 그대로 → 수정 뒤 숫자 사라짐
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('탭 숫자 = 그 종류의 읽지 않은 것(내가 결정할 참여 요청 포함), 0이면 숨김', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const unreadOf = \(k\) => items\.filter\(\(it\) => it\.kind === k && \(isNew\(it\) \|\| pendingMine\(it\)\)\)\.length;/);
  assert.match(src, /\{!phone && k !== 'all' && unreadOf\(k\) > 0 && <span className="n">\{unreadOf\(k\)\}<\/span>\}/);
  assert.doesNotMatch(src, /items\.filter\(\(it\) => it\.kind === k\)\.length/, '총수 표시 없음');
});
