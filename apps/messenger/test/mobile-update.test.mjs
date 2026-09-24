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
  assert.match(src, /observeMobileResume\(\(\) => check\('foreground'\)\)/);
  assert.match(src, /setInterval\(\(\) => check\('interval'\)/);
  assert.match(src, /shouldCheckMobile\(\{ reason, foreground, now: Date\.now\(\), lastCheckAt: r\.lastCheckAt \}\)/);
});

test('Android 권한 부족은 별도 화면(permission)으로 — 조용히 실패로 떨어지지 않는다', () => {
  assert.match(src, /PERMISSION_REQUIRED/);
  assert.match(src, /phase: 'permission'/);
  assert.match(src, /open_unknown_sources_settings/);
});

test('iOS는 다운로드가 아니라 TestFlight를 연다(스토어 밖 자가설치 금지)', () => {
  assert.match(src, /itms-beta:\/\//);
  assert.match(src, /isIos[\s\S]{0,80}openTestFlight/);
});

test('App.jsx에 실제로 걸려 있다', () => {
  assert.match(app, /import \{ MobileUpdateBar \} from '\.\/mobile-update\.jsx';/);
  assert.match(app, /<MobileUpdateBar t=\{t\} \/>/);
});
