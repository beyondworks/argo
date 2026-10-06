// MSG-09·10·11·12(2026-10-05 분리 검증) — 폰 입력창 높이, Android 뒤로, Android 업데이트 실패 안내, 최상위 오류 화면.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackStack, rootBackAction } from '../src/back-stack.mjs';
import { mobileUpdateFailure } from '../src/update-release.mjs';
import { rootErrorView } from '../src/root-error.mjs';
import { t } from '../src/i18n.js';

test('MSG-10 뒤로는 열린 시트·팝업부터 닫는다 — 맨 위(마지막에 연) 것 하나씩, 닫으면 목록에서 빠진다', () => {
  const s = createBackStack(); const closed = [];
  const offA = s.push(() => closed.push('peek')); s.push(() => closed.push('photo'));
  assert.equal(s.closeTop(), true); assert.deepEqual(closed, ['photo']);
  offA(); // 시트가 스스로 닫힘(바깥 누름 등) — 목록에서 빠진다
  assert.equal(s.closeTop(), false, '열린 것이 없으면 화면 뒤로로 넘긴다');
});

test('MSG-10 맨 아래 화면(깊이 0)의 뒤로 — 다른 탭이면 홈 탭으로, 홈 탭이면 처음엔 안내, 2초 안에 한 번 더면 종료', () => {
  assert.equal(rootBackAction({ page: 'agents', home: 'chats', lastAt: 0, now: 10_000 }), 'home');
  assert.equal(rootBackAction({ page: 'chats', home: 'chats', lastAt: 0, now: 10_000 }), 'warn');
  assert.equal(rootBackAction({ page: 'chats', home: 'chats', lastAt: 9_000, now: 10_000 }), 'exit');
  assert.equal(rootBackAction({ page: 'chats', home: 'chats', lastAt: 7_000, now: 10_000 }), 'warn', '2초가 지났으면 다시 안내');
});

test('MSG-11 Android 업데이트 실패는 사용자 문구 + 다음 할 일 — 같은 실패가 되풀이되는 원인은 다시 시도 대신 다운로드 페이지', () => {
  for (const e of ['no-apk-asset', 'missing-sha256', 'SHA256_REQUIRED: release asset has no sha256 digest', 'downloaded file does not match the expected sha256', 'host not allowed: evil.example', 'download failed: HTTP 404']) {
    const v = mobileUpdateFailure(e); assert.deepEqual([v.key, v.retry, v.download], ['upd.mobile.fail.asset', false, true], e);
  }
  const pick = (v) => [v.key, v.retry, v.download];
  assert.deepEqual(pick(mobileUpdateFailure('download failed: HTTP 403')), ['upd.mobile.fail.busy', false, true], 'GitHub 한도 — 나중에');
  assert.deepEqual(pick(mobileUpdateFailure('java.net.SocketTimeoutException: timeout')), ['upd.mobile.fail.network', true, true]);
  assert.deepEqual(pick(mobileUpdateFailure('a download is already in progress (ALREADY_DOWNLOADING)')), ['upd.mobile.fail.already', false, false]);
  for (const k of ['upd.mobile.fail.asset', 'upd.mobile.fail.busy', 'upd.mobile.fail.network', 'upd.mobile.fail.already', 'upd.mobile.download']) assert.notEqual(t(k, 'ko'), k, `${k} 사전에 있다`);
  assert.doesNotMatch(t('upd.mobile.fail.asset', 'en'), /sha256|apk|asset/i, '내부 코드가 문구에 없다');
});

test('MSG-12 최상위 오류 화면 — 저장된 언어(argo-lang)와 다크를 따른다, 다시 불러오기 단추', () => {
  const en = rootErrorView({ lang: 'en', dark: true });
  assert.match(en.title, /Something went wrong/); assert.equal(en.reload, 'Reload');
  assert.match(en.fg, /^var\(--fg, #[0-9a-f]{6}\)$/i); assert.match(en.bg, /^var\(--bg, #[0-9a-f]{6}\)$/i);
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3; };
  const fb = (v) => v.match(/#[0-9a-f]{6}/i)[0];
  assert.ok(lum(fb(en.fg)) > lum(fb(en.bg)), '다크: 글자가 바탕보다 밝다(토큰이 없을 때의 대체값도)');
  const ko = rootErrorView({ lang: 'ko', dark: false });
  assert.equal(ko.reload, '다시 불러오기'); assert.ok(lum(fb(ko.fg)) < lum(fb(ko.bg)), '라이트: 글자가 바탕보다 어둡다');
});

test('MSG-09 입력창은 열릴 때(방을 옮겨 오거나 새로고침으로 초안을 되살릴 때) 초안 높이로 맞춘다 — 실제 Composer 코드', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function Composer('));
  const autosizeSrc = fn.slice(fn.indexOf('  const autosize = (el) =>'), fn.indexOf('\n', fn.indexOf('  const autosize = (el) =>')));
  const mountAt = fn.indexOf('useLayoutEffect(() => { autosize(ta.current); }, [chId]);');
  assert.ok(mountAt > 0, '열릴 때 높이 맞춤이 있다');
  const el = { style: { height: '' }, scrollHeight: 150 };
  const run = new Function('el', `${autosizeSrc}\nautosize(el); return el.style.height;`);
  assert.equal(run(el), '150px', '7줄 초안이 2줄 높이(44px)로 잘리지 않는다');
  assert.equal(run({ style: { height: '' }, scrollHeight: 0 }), '', '숨은 입력창(높이를 못 재는 때)은 0px로 굳히지 않는다');
});
