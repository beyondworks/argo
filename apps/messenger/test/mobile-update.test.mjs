// 폰 업데이트 배선 — 순수 판정은 update-schedule.test.mjs·update-release.test.mjs가 잠근다. 여기는 소스 대조로:
// (1) 판정 출처가 GitHub 릴리스 메타 하나(Supabase 쓰기 0), (2) 백그라운드 중엔 확인 안 함(shouldCheckMobile에 위임),
// (3) Android 설치 권한 오류 코드가 별도 안내 화면으로 갈라지는지, (4) App.jsx에 실제로 걸려 있는지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/mobile-update.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('판정 출처는 GitHub 릴리스 메타 하나 — Supabase·다른 쓰기 없음', () => {
  assert.match(src, /const RELEASE_API = 'https:\/\/api\.github\.com\/repos\/beyondworks\/argo-messenger\/releases\/latest';/);
  assert.ok(!/from '\.\/supabase/i.test(src) && !/supabase\./.test(src), 'mobile-update.jsx는 Supabase를 직접 부르지 않는다(GitHub 메타만)');
});

test('확인 시점 — 시작·포그라운드 복귀(observeMobileResume)·주기, 백그라운드 여부는 shouldCheckMobile에 위임', () => {
  assert.match(src, /check\('start'\)/);
  assert.match(src, /observeMobileResume\(\(\) => \{ if \(ref\.current\.phase === 'permission'\) downloadRef\.current\(\); else check\('foreground'\); \}\)/);
  assert.match(src, /setInterval\(\(\) => check\('interval'\)/);
  assert.match(src, /shouldCheckMobile\(\{ reason, foreground, now: Date\.now\(\), lastCheckAt: r\.lastCheckAt \}\)/);
});

test('마지막 확인 시각을 sessionStorage에 둔다 — 새로고침 직후의 start가 메모리 초기화로 간격 판정을 우회하지 못하게', () => {
  assert.match(src, /const LAST_CHECK_KEY = 'msgr-update-last-check';/);
  assert.match(src, /sessionStorage\.getItem\(LAST_CHECK_KEY\)/);
  assert.match(src, /sessionStorage\.setItem\(LAST_CHECK_KEY, String\(at\)\)/);
  assert.match(src, /lastCheckAt: readLastCheckAt\(\)/, '마운트 시 ref 초기값이 sessionStorage에서 온다');
  assert.match(src, /r\.lastCheckAt = Date\.now\(\); writeLastCheckAt\(r\.lastCheckAt\);/);
});

test('Android 권한 부족은 별도 화면(permission)으로 — 조용히 실패로 떨어지지 않고, 설정에서 돌아오면 자동 재시도한다', () => {
  assert.match(src, /PERMISSION_REQUIRED/);
  assert.match(src, /phase: 'permission'/);
  assert.match(src, /open_unknown_sources_settings/);
  assert.match(src, /downloadRef\.current = downloadAndInstall;/, '재개 시 최신 downloadAndInstall을 부를 수 있어야 한다');
});

test('무결성 대조 불가(sha256 없음) 자산은 설치하지 않는다', () => {
  assert.match(src, /if \(!asset\.sha256\) \{ ref\.current\.phase = 'error'; setSt\(\(s\) => \(\{ \.\.\.s, phase: 'error', error: 'missing-sha256' \}\)\); return; \}/);
});

test('iOS는 다운로드가 아니라 TestFlight를 연다(스토어 밖 자가설치 금지)', () => {
  assert.match(src, /itms-beta:\/\//);
  assert.match(src, /isIos[\s\S]{0,80}openTestFlight/);
});

test('App.jsx에 실제로 걸려 있다', () => {
  assert.match(app, /import \{ MobileUpdateBar \} from '\.\/mobile-update\.jsx';/);
  assert.match(app, /<MobileUpdateBar t=\{t\} \/>/);
});
