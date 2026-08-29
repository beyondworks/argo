// Windows 폰트 가독성 오버라이드 — osBoot(OS 판별 부트 스크립트) 행동 테스트.
// 실사용 제보(2026-08-29): Windows에서 앱 전역 텍스트가 흐리고(힌팅 없는 Pretendard),
// mono 계열 한글이 굴림계로 떨어짐. 처방 = data-os='win'일 때만 globals.css가
// 시스템 폰트로 전환(맥·리눅스는 미부여라 CSS 경로 불변).
// 이 테스트는 layout.jsx의 osBoot 문자열을 **실제로 실행**해 UA별 부여를 검증한다
// (소스 문자열 단언이 아니라 스크립트 행동) — CSS 캐스케이드 자체는 실브라우저로
// 검증했다(2026-08-29 Aside 실측: 기본=무변화·win=전환·retro 개성 유지·apple 커버).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const layout = readFileSync(join(ROOT, 'app', 'layout.jsx'), 'utf8');

function extractBoot() {
  const m = layout.match(/const osBoot = `([^`]+)`/);
  assert.ok(m, 'layout.jsx에 osBoot 부트 스크립트가 있어야 한다');
  return m[1];
}

function runBoot(userAgent) {
  const dataset = {};
  const ctx = {
    navigator: { userAgent },
    document: { documentElement: { dataset } },
  };
  vm.runInNewContext(extractBoot(), ctx);
  return dataset;
}

test('Windows UA(데스크톱 웹뷰·크롬)면 data-os=win을 박는다', () => {
  const winWebview = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
  assert.equal(runBoot(winWebview).os, 'win');
});

test('맥·리눅스 UA는 미부여 — CSS 경로 불변(맥 렌더 유지 보장)', () => {
  const macWebview = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  assert.equal(runBoot(macWebview).os, undefined);
  assert.equal(runBoot(linux).os, undefined);
});

test('navigator가 없어도 부트가 던지지 않는다(try 가드)', () => {
  const ctx = { document: { documentElement: { dataset: {} } } };
  assert.doesNotThrow(() => vm.runInNewContext(extractBoot(), ctx));
});

test('layout이 osBoot를 첫 페인트 전 스크립트로 배선한다', () => {
  // 배선 게이트 — 상수만 있고 <script>에 안 실리면 전부 무동작(호출부 단위 게이트 교훈).
  assert.match(layout, /__html:\s*osBoot/, 'osBoot가 인라인 스크립트로 주입돼야 한다');
});
