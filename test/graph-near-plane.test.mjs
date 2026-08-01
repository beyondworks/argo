// 별자리·기억 그래프가 통째로 사라지던 결함의 회귀 테스트.
//
// 실사용 신고 2026-08-02: 옵시디언 볼트를 가져온 뒤 별자리와 기억 그래프가 빈 화면이 됐다.
// 데이터는 멀쩡했다(카드에 "노드 1818개"가 그대로 찍혔다). 원인은 **투영에 근평면이 없던 것**:
//   k = f / (f + z + 260)
// 노드가 카메라 뒤로 넘어가면 분모가 음수가 되어 k가 음수가 되고, 그 k가 노드 반지름에 곱해져
// ctx.arc가 "The radius provided (-102.675) is negative"로 **예외를 던진다**. 그 예외는 rAF 콜백을
// 뚫고 나가 루프 재등록(raf = requestAnimationFrame(frame))을 막으므로, 그래프는 첫 프레임에 죽고
// 영영 안 돌아온다. 회사가 작을 땐 구름 반경이 카메라 거리보다 작아 아무도 뒤로 넘어가지 않아
// 멀쩡했다 — 그래서 "임포트 이후 갑자기" 사라진 것처럼 보였다.
//
// 여기서 잠그는 계약:
//  ① 원근 나눗셈에 근평면 가드가 있다(분모가 0 이하면 k = 0).
//  ② 그리는 쪽(엣지·노드)과 고르는 쪽(픽킹) 모두 k <= 0을 건너뛴다.
//     — 건너뛰지 않으면 k=0인 점의 좌표가 화면 중앙으로 모여 보이지도 않는 노드가 집혀 버린다.
//  ③ 프레임 비용이 노드 수에 비례해 폭발하지 않게, 색은 깊이 구간별로 한 번만 칠한다.
//     (노드마다 fillStyle에 rgba 문자열을 넣으면 캔버스가 매번 색을 파싱한다 — 1818노드에서
//      프레임당 5천 회를 넘겨 캔버스 호출 자체보다 훨씬 비쌌다. 실측 63.7ms → 8.1ms)
//
// .jsx는 Node가 직접 import할 수 없어(JSX 파싱) 텍스트로 본다 — 이 레포의 다른 UI 트립와이어와 같은 방식.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app/c/[ws]/graphview.jsx', import.meta.url), 'utf8');

test('① 원근 나눗셈에 근평면 가드가 있다 — 없으면 반지름이 음수가 되어 첫 프레임에 죽는다', () => {
  assert.match(src, /const den = f \+ z \+ 260;/, '분모를 따로 잡아야 부호를 볼 수 있다');
  assert.match(src, /const k = den > \d+ \? f \/ den : 0;/,
    '분모가 0 이하일 때 k를 0으로 — 이 한 줄이 없으면 k가 음수가 되어 ctx.arc가 예외를 던진다');
  assert.doesNotMatch(src, /const k = f \/ \(f \+ z \+ 260\);/, '가드 없는 옛 식이 되살아나면 안 된다');
});

test('② 그리는 쪽·고르는 쪽 모두 카메라 뒤 점을 건너뛴다', () => {
  const guards = (src.match(/k <= 0/g) ?? []).length;
  assert.ok(guards >= 4,
    `엣지·노드·픽킹 2곳 = 최소 4곳에서 걸러야 한다(현재 ${guards}곳). 한 곳이라도 빠지면 보이지 않는 점이 집히거나 선이 화면을 가로질러 튄다`);
  assert.match(src, /if \(a\.k <= 0 \|\| b\.k <= 0\) continue;/, '엣지: 한쪽이라도 뒤면 그리지 않는다');
  assert.match(src, /if \(q\.k <= 0\) continue;/, '노드: 반지름이 음수가 되는 바로 그 점들');
  assert.equal((src.match(/if \(q\.k <= 0\) return;/g) ?? []).length, 2,
    '픽킹은 미니·전체화면 두 곳 — 한 곳만 고치면 다른 화면에서 유령 노드가 집힌다');
});

test('③ 색은 노드마다가 아니라 깊이 구간별로 — 프레임 비용이 노드 수에 비례하지 않게', () => {
  assert.match(src, /new Path2D\(\)/, '경로에 모아 한 번에 긋는다');
  // 개별 그리기는 회사 노드·호버·라벨 노드(합쳐야 십수 개)에만 남아야 한다.
  assert.match(src, /const singles = \[\]/, '개별 처리 대상은 명시적으로 분리');
  assert.ok(!/for \(const \[, i\] of order\) \{[\s\S]{0,900}?ctx\.fillStyle = `rgba\(\$\{ACCENT\}, \$\{\(hi \? 0\.16/.test(src),
    '깊이 정렬 루프 안에서 노드마다 fillStyle을 세팅하던 옛 구조로 돌아가면 안 된다');
});

test('시뮬레이션은 자리를 잡으면 멈춘다 — 수렴한 뒤로는 같은 그림을 다시 계산할 뿐이다', () => {
  assert.equal((src.match(/if \(settle < \d+\) \{ sim\.tick\(\); settle\+\+; \}/g) ?? []).length, 2,
    '미니·전체화면 두 루프 모두');
});
