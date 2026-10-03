// 모바일 웹뷰 바탕(webview-bg.js) — 창 설정의 스플래시 색(#1F1E1B)이 스플래시가 닫힌 뒤에도 남으면 라이트 테마에서 키보드·회전·바운스로
// 드러나는 자리가 어둡게 보인다(반대 검토 #7). 닫히면 지금 테마 바탕으로 바꾸고, 테마가 바뀔 때만 다시 부른다(같은 값이면 호출 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followThemeBackground } from '../src/webview-bg.js';

function fake(bg) {
  const calls = [];
  const observers = [];
  const mq = [];
  const state = { bg };
  const win = {
    __TAURI__: { webview: { getCurrentWebview: () => ({ setBackgroundColor: (c) => { calls.push(c); return Promise.resolve(); } }) } },
    getComputedStyle: () => ({ backgroundColor: state.bg }),
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(target, opts) { this.opts = opts; } },
    matchMedia: () => ({ addEventListener: (n, cb) => mq.push(cb) }),
  };
  const doc = { body: {}, documentElement: {} };
  return { win, doc, calls, state, fireTheme: () => observers.forEach((o) => o.cb()), fireScheme: () => mq.forEach((cb) => cb()), observers };
}

test('스플래시가 닫히면 테마 바탕으로 한 번 바꾼다', () => {
  const f = fake('rgb(244, 241, 234)');
  assert.equal(followThemeBackground(f.win, f.doc), true);
  assert.deepEqual(f.calls, [[244, 241, 234]]);
  assert.deepEqual(f.observers[0].opts, { attributes: true, attributeFilter: ['data-theme'] }, '테마 속성만 본다');
});

test('같은 색이면 다시 부르지 않고, 테마가 바뀌면 따라간다', () => {
  const f = fake('rgb(244, 241, 234)');
  followThemeBackground(f.win, f.doc);
  f.fireTheme(); f.fireScheme();
  assert.equal(f.calls.length, 1, '값이 같으면 호출 0');
  f.state.bg = 'rgb(32, 32, 32)';
  f.fireTheme();
  assert.deepEqual(f.calls, [[244, 241, 234], [32, 32, 32]]);
});

test('투명 바탕(테마 미정)·Tauri 없음(브라우저·테스트)에서는 아무것도 안 한다', () => {
  const f = fake('rgba(0, 0, 0, 0)');
  followThemeBackground(f.win, f.doc);
  assert.equal(f.calls.length, 0);
  const g = fake('rgb(1, 2, 3)');
  delete g.win.__TAURI__;
  assert.equal(followThemeBackground(g.win, g.doc), false);
});

// iOS(유건 실기기 제보 2026-10-03) — Tauri의 웹뷰 바탕 명령은 데스크톱에만 등록돼 iOS에서는 조용히 실패했고, 라이트 테마에서
// 키보드 위·둥근 모서리 뒤로 스플래시 색(#1F1E1B)이 검은 띠로 남았다. iOS는 앱 플러그인 ios-webview의 set_background로 간다.
function fakeIos(bg) {
  const f = fake(bg);
  const invokes = [];
  f.win.__TAURI__.core = { invoke: (cmd, args) => { invokes.push([cmd, args]); return Promise.resolve(); } };
  return { ...f, invokes };
}

test('iOS는 ios-webview 플러그인 명령으로 칠하고, 데스크톱 전용 웹뷰 명령은 부르지 않는다', () => {
  const f = fakeIos('rgb(233, 230, 223)');
  assert.equal(followThemeBackground(f.win, f.doc, 'ios'), true);
  assert.deepEqual(f.invokes, [['plugin:ios-webview|set_background', { red: 233, green: 230, blue: 223 }]]);
  assert.equal(f.calls.length, 0, 'iOS에 없는 set_webview_background_color 경로는 타지 않는다');
  f.fireTheme();
  assert.equal(f.invokes.length, 1, '같은 색이면 호출 0');
  f.state.bg = 'rgb(31, 30, 27)';
  f.fireScheme();
  assert.deepEqual(f.invokes[1], ['plugin:ios-webview|set_background', { red: 31, green: 30, blue: 27 }], '시스템 다크로 바뀌면 따라간다');
});

test('Android·데스크톱은 그대로 Tauri 웹뷰 명령(플랫폼 값이 없거나 ios가 아니면)', () => {
  for (const platform of [undefined, 'android', 'macos']) {
    const f = fakeIos('rgb(244, 241, 234)');
    followThemeBackground(f.win, f.doc, platform);
    assert.deepEqual(f.calls, [[244, 241, 234]], String(platform));
    assert.equal(f.invokes.length, 0, String(platform));
  }
});

test('iOS인데 Tauri 호출 수단이 없으면 아무것도 안 한다', () => {
  const f = fake('rgb(1, 2, 3)');
  assert.equal(followThemeBackground(f.win, f.doc, 'ios'), false);
  assert.equal(f.calls.length, 0);
});

test('iOS 네이티브 배선 — 플러그인 등록·권한·명령 이름이 서로 맞는다', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('src-tauri/Cargo.toml'), /\[target\.'cfg\(target_os = "ios"\)'\.dependencies\][^[]*tauri-plugin-ios-webview = \{ path = "plugins\/ios-webview" \}/, 'iOS에만 의존');
  assert.match(read('src-tauri/src/lib.rs'), /#\[cfg\(target_os = "ios"\)\]\s*let builder = builder\.plugin\(tauri_plugin_ios_webview::init\(\)\)/, 'iOS에서만 등록');
  const cap = JSON.parse(read('src-tauri/capabilities/ios-webview.json'));
  assert.deepEqual([cap.platforms, cap.permissions], [['iOS'], ['ios-webview:default']]);
  assert.match(read('src-tauri/plugins/ios-webview/permissions/default.toml'), /permissions = \["allow-set-background"\]/);
  assert.match(read('src-tauri/plugins/ios-webview/build.rs'), /COMMANDS: &\[&str\] = &\["set_background"\]/);
  assert.match(read('src-tauri/plugins/ios-webview/src/lib.rs'), /Builder::new\("ios-webview"\)[\s\S]*generate_handler!\[ios::set_background\]/);
  const swift = read('src-tauri/plugins/ios-webview/ios/Sources/IosWebviewPlugin.swift');
  // load() 본문 안의 호출만 인정한다 — [\s\S]*로 두면 아래 hideFormAccessoryBar 정의와도 맞아 호출을 지워도 통과했다(분리 검수 M2).
  // 네이티브 동작(막대가 실제로 사라지는지·바탕색)은 문자열로 증명되지 않는다 — 시뮬레이터 확인 항목으로 따로 남긴다.
  assert.match(swift, /override func load\(webview: WKWebView\) \{[^}]*Self\.hideFormAccessoryBar\(\)[^}]*\}/, '플러그인이 실릴 때 보조 막대를 숨긴다');
  assert.match(swift, /@convention\(block\) \(AnyObject\) -> UIView\? = \{ _ in nil \}/, '보조 막대 getter는 nil을 돌려준다');
  assert.match(swift, /webview\.backgroundColor = color\s+webview\.scrollView\.backgroundColor = color/, '웹뷰와 스크롤 뷰를 테마 색으로 칠한다');
  assert.match(swift, /@objc public func setBackground\(_ invoke: Invoke\)/, 'Rust의 run_mobile_plugin("setBackground")와 같은 이름');
  assert.match(swift, /@_cdecl\("init_plugin_ios_webview"\)/);
});
