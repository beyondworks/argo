// 메신저 출하(부록 L) — 서버 프로필(행동)·업데이터·릴리스 워크플로·마켓 카드·랜딩 링크 핀.
//  · server-profile.mjs는 순수 모듈: 반쪽 프로필은 null, URL은 스킴·호스트만, 끝 슬래시 제거
//  · supabase.js는 프로필이 env보다 우선, 프로필 없으면 env(빌드 기본 = Argo 클라우드)
//  · tauri.conf: 업데이터 endpoint가 메신저 릴리스 repo, 업데이터 아티팩트 생성, CSP가 회사 서버(https/wss 일반)를 막지 않는다
//  · lib.rs·capabilities에 updater·process 배선, Cargo.toml에 크레이트
//  · 워크플로: 3타깃 매트릭스·apps/messenger 작업 디렉터리·버전 게이트·고정 파일명 3종·릴리스 repo
//  · 마켓 카드 i18n ko/en, 메신저 새 키 ko/en
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfile, normalizeUrl, readProfile, writeProfile, clearProfile, hostOf, PROFILE_KEY } from '../apps/messenger/src/server-profile.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('normalizeUrl: 스킴+호스트만 허용, 끝 슬래시·공백 제거, 경로·잘못된 값은 빈 문자열', () => {
  assert.equal(normalizeUrl(' https://sb.company.com/ '), 'https://sb.company.com');
  assert.equal(normalizeUrl('http://10.0.0.5:8000'), 'http://10.0.0.5:8000');
  assert.equal(normalizeUrl('sb.company.com'), '', '스킴 없음');
  assert.equal(normalizeUrl('https://sb.company.com/rest/v1'), '', '경로 포함');
  assert.equal(normalizeUrl(null), '');
});

test('parseProfile: 둘 다 있어야 프로필, 반쪽·깨진 JSON은 null(반쪽 프로필로 접속하지 않는다)', () => {
  assert.deepEqual(parseProfile(JSON.stringify({ url: 'https://a.b/', anon: ' k ' })), { url: 'https://a.b', anon: 'k' });
  assert.equal(parseProfile(JSON.stringify({ url: 'https://a.b' })), null);
  assert.equal(parseProfile(JSON.stringify({ anon: 'k' })), null);
  assert.equal(parseProfile(JSON.stringify({ url: 'a.b', anon: 'k' })), null);
  assert.equal(parseProfile('{not json'), null);
  assert.equal(parseProfile(''), null);
});

test('read/write/clear: 저장소 왕복, 저장 안 된 기기는 null, 던지는 저장소도 null', () => {
  const s = mem();
  assert.equal(readProfile(s), null);
  writeProfile(s, { url: 'https://a.b/', anon: 'k' });
  assert.equal(JSON.parse(s.getItem(PROFILE_KEY)).url, 'https://a.b');
  assert.deepEqual(readProfile(s), { url: 'https://a.b', anon: 'k' });
  clearProfile(s);
  assert.equal(readProfile(s), null);
  assert.equal(readProfile({ getItem() { throw new Error('blocked'); } }), null);
  assert.equal(readProfile(null), null);
  assert.equal(hostOf('https://a.b:8443/x'), 'a.b:8443');
  assert.equal(hostOf('nope'), '');
});

test('supabase.js: 프로필이 env보다 우선하고, 없으면 env', () => {
  const s = read('apps/messenger/src/supabase.js');
  assert.match(s, /readProfile\(typeof localStorage !== 'undefined' \? localStorage : null\)/);
  assert.match(s, /SB_URL = profile\?\.url \?\? import\.meta\.env\.VITE_SUPABASE_URL/);
  assert.match(s, /SB_ANON = profile\?\.anon \?\? import\.meta\.env\.VITE_SUPABASE_ANON_KEY/);
  const app = read('apps/messenger/src/App.jsx');
  assert.match(app, /function ServerRow\(\{ t, open = false \}\)/, '서버 행 컴포넌트(모듈 수준)');
  assert.match(app, /<ServerRow t=\{t\} \/>\n\s*<div className="foot">/, '로그인 카드 foot 앞에 서버 행');
  assert.match(app, /notConfigured'\)\}<\/p><ServerRow t=\{t\} open \/>/, 'env 없는 빌드도 서버를 넣을 수 있어야 한다');
  assert.match(app, /<Sprite \/><UpdateBar t=\{t\} \/>\{body\}/, '업데이트 막대는 모든 화면 위');
});

test('tauri.conf·Rust·capabilities: 업데이터 배선과 회사 서버를 막지 않는 CSP', () => {
  const conf = JSON.parse(read('apps/messenger/src-tauri/tauri.conf.json'));
  assert.deepEqual(conf.plugins.updater.endpoints, ['https://github.com/beyondworks/argo-messenger/releases/latest/download/latest.json']);
  assert.equal(conf.plugins.updater.pubkey, JSON.parse(read('src-tauri/tauri.conf.json')).plugins.updater.pubkey, 'Argo 앱과 같은 서명 키(TAURI_SIGNING_PRIVATE_KEY 재사용)');
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.match(conf.app.security.csp, /connect-src 'self' https: wss: /, '셀프호스트 서버(임의 호스트)는 *.supabase.co 한정 CSP에 막힌다');
  for (const ic of conf.bundle.icon) assert.doesNotThrow(() => readFileSync(new URL(`../apps/messenger/src-tauri/${ic}`, import.meta.url)), `아이콘 실재: ${ic}`);
  const rs = read('apps/messenger/src-tauri/src/lib.rs');
  assert.match(rs, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(rs, /tauri_plugin_process::init\(\)/);
  const cap = JSON.parse(read('apps/messenger/src-tauri/capabilities/desktop.json'));
  assert.ok(cap.permissions.includes('updater:default') && cap.permissions.includes('process:default'));
  assert.deepEqual(cap.platforms, ['macOS', 'windows', 'linux']);
  const common = JSON.parse(read('apps/messenger/src-tauri/capabilities/default.json'));
  assert.ok(!common.permissions.includes('updater:default') && !common.permissions.includes('process:default'));
  const mobile = JSON.parse(read('apps/messenger/src-tauri/capabilities/mobile.json'));
  assert.deepEqual(mobile.platforms, ['iOS', 'android']);
  assert.ok(mobile.permissions.includes('deep-link:default'));
  // 로그인 복귀 스킴은 네이티브 매니페스트에 실제로 등록돼야 브라우저에서 앱으로 돌아온다(플러그인 설정만으로는 iOS에 안 실린다 — 2026-09-10 실측: 시뮬레이터 openurl 115).
  assert.deepEqual(JSON.parse(read('apps/messenger/src-tauri/tauri.android.conf.json')).plugins['deep-link'].mobile[0].scheme, ['argo-messenger'], 'Android conf 스킴');
  // iOS도 argo-messenger:// 를 앱 URL 스킴으로 등록한다(0.1.7 복구). 2026-09-10에는 "시트와 충돌해 코드 미교환"으로 비웠으나(#475), 스킴이 없으면
  // 시트 밖으로 샌 리디렉션(Safari·구글 앱)이 '애플리케이션을 열 수 없습니다'로 끝나 0.1.4~0.1.6 전부 복귀 불가였다(2026-09-11 실사고).
  // 두 관찰을 함께 덮는 처방: 스킴 등록 + mobile-auth-runtime.js가 시트 콜백과 딥링크를 같은 경로로 한 번만 소비(아래 핀). 실기 검증은 0.1.7 빌드 2 TestFlight에서.
  assert.match(read('apps/messenger/src-tauri/gen/apple/argo-messenger_iOS/Info.plist'), /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>argo-messenger<\/string>/, 'iOS Info.plist에 argo-messenger 스킴');
  assert.deepEqual(JSON.parse(read('apps/messenger/src-tauri/tauri.ios.conf.json')).plugins['deep-link'].mobile[0].scheme, ['argo-messenger'], 'iOS deep-link 스킴(비우면 플러그인 build.rs가 Info.plist 스킴을 지운다)');
  // Android는 인텐트(딥링크)로 콜백을 받는다 — 스킴 유지.
  assert.match(read('apps/messenger/src-tauri/gen/android/app/src/main/AndroidManifest.xml'), /<data android:scheme="argo-messenger" \/>/, 'Android 매니페스트 intent-filter에 argo-messenger 스킴');
  // iOS 로그인은 외부 브라우저가 아니라 애플 표준 로그인 창(ASWebAuthenticationSession)으로 — Chrome 등 서드파티 기본 브라우저는
  // 서버 리디렉션의 커스텀 스킴을 앱에 넘기지 않아 '대기'에서 멈춘다(2026-09-10 실기: Safari만 동작).
  const iosCap = JSON.parse(read('apps/messenger/src-tauri/capabilities/ios.json'));
  assert.deepEqual(iosCap.platforms, ['iOS']); assert.ok(iosCap.permissions.includes('web-auth:default'));
  assert.match(read('apps/messenger/src-tauri/Cargo.toml'), /\[target\.'cfg\(target_os = "ios"\)'\.dependencies\]\s*\ntauri-plugin-web-auth = \{ path = "plugins\/web-auth" \}/, 'iOS에만 web-auth 플러그인');
  assert.match(rs, /#\[cfg\(target_os = "ios"\)\]\s*let builder = builder\.plugin\(tauri_plugin_web_auth::init\(\)\)/, 'lib.rs iOS 플러그인 등록');
  const swift = read('apps/messenger/src-tauri/plugins/web-auth/ios/Sources/WebAuthPlugin.swift');
  assert.match(swift, /ASWebAuthenticationSession\(url: url, callbackURLScheme: args\.callbackScheme\)/);
  assert.match(swift, /prefersEphemeralWebBrowserSession = false/, '기존 Safari 로그인 세션 공유(구글 재로그인 불필요)');
  assert.match(swift, /url\.scheme == "https"/, '로그인 창은 https만 연다');
  const rt = read('apps/messenger/src/mobile-auth-runtime.js');
  assert.match(rt, /invoke\('plugin:web-auth\|start', \{ url, callbackScheme: MOBILE_AUTH_CALLBACK\.split\(':'\)\[0\] \}\)/, 'iOS start → web-auth');
  assert.match(rt, /if \(!isIos\) return openerOpenUrl\(url\);/, 'Android는 외부 브라우저+딥링크 그대로');
  assert.match(rt, /const stop = await deepLinkOnOpenUrl\(deliver\);/, '두 플랫폼 모두 딥링크 수신(iOS는 시트 밖으로 샌 콜백 대비)');
  assert.doesNotMatch(rt, /if \(isIos\) return \(\) => receivers\.delete\(handler\);/, 'iOS 딥링크 수신 차단 금지(2026-09-11 실사고)');
  assert.match(rt, /then\(\(result\) => \{ if \(result\?\.url\) deliver\(\[result\.url\]\); else runtime\.cancel\(\); \}\)/, '시트 콜백 URL을 딥링크와 같은 deliver 경로로');
  assert.match(rt, /!delivered\.has\(u\)\)[\s\S]{0,120}for \(const u of fresh\) delivered\.add\(u\);\s*if \(fresh\.length\) for \(const handler of receivers\) handler\(fresh\);/, '같은 콜백 URL은 한 번만(시트+딥링크 중복 교환 방지)');
  assert.match(rt, /else runtime\.cancel\(\)/, '취소·오류는 대기 해제');
  const toml = read('apps/messenger/src-tauri/Cargo.toml');
  assert.match(toml, /tauri-plugin-updater = "2"/); assert.match(toml, /tauri-plugin-process = "2"/);
  const pkg = JSON.parse(read('apps/messenger/package.json'));
  assert.ok(pkg.dependencies['@tauri-apps/plugin-updater'] && pkg.dependencies['@tauri-apps/plugin-process']);
  assert.match(read('apps/messenger/src-tauri/Cargo.lock'), /name = "argo-messenger"\nversion = "\d+\.\d+\.\d+"/, 'Cargo.lock 추적(bump-version --root 앵커)');
});

test('release-messenger.yml: 3타깃·작업 디렉터리·버전 게이트·고정 파일명·릴리스 repo·전부-또는-없음', () => {
  const y = read('.github/workflows/release-messenger.yml');
  for (const t of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) assert.match(y, new RegExp(`rust_target: ${t}`));
  assert.match(y, /working-directory: apps\/messenger/);
  assert.match(y, /bump-version\.mjs --root apps\/messenger --check "v\$\{GITHUB_REF_NAME#messenger-v\}"/);
  for (const f of ['argo-messenger-macos-apple-silicon.dmg', 'argo-messenger-macos-intel.dmg', 'argo-messenger-windows-setup.exe']) assert.match(y, new RegExp(f));
  assert.match(y, /repository: beyondworks\/argo-messenger/);
  assert.match(y, /tags: \['messenger-v\*'\]/);
  assert.match(y, /node scripts\/release-assets\.mjs dist argo-messenger/);
  assert.match(y, /if: success\(\) && startsWith/);
  assert.doesNotMatch(y, /MANIFEST-INCOMPLETE|if: always\(\)/);
  assert.match(y, /VITE_SUPABASE_URL: \$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}/);
  assert.doesNotMatch(y, /SERVICE_ROLE/, '서버 시크릿은 데스크톱 빌드에 넣지 않는다');
});

test('설정 연결 카드·메신저 새 i18n 키는 ko/en 쌍', () => {
  const page = read('app/c/[ws]/settings/page.jsx');
  assert.doesNotMatch(read('app/c/[ws]/market/page.jsx'), /MessengerAppCard|MSGR_DL/, '다운로드 카드는 설정 연결에만 둔다');
  const i18n = read('app/i18n.jsx');
  const keys = new Set([...page.slice(page.indexOf('function MsgrCard('), page.indexOf('function ConnectorsCard(')).matchAll(/t\('([A-Za-z0-9._-]+)'\)/g)].map((m) => m[1]));
  assert.ok(keys.size >= 6, `키 수집 ${keys.size}`);
  for (const k of keys) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko·en`);
  const m = read('apps/messenger/src/i18n.js');
  for (const k of ['auth.server', 'auth.server.cloud', 'auth.server.custom', 'auth.server.desc', 'auth.server.key', 'auth.server.save', 'auth.server.reset', 'auth.server.bad', 'upd.available', 'upd.install', 'upd.later', 'upd.installing', 'upd.ready', 'upd.restart', 'upd.error']) {
    assert.match(m, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko·en`);
  }
  for (const f of ['docs/privacy-sync.md', 'docs/selfhost.md']) assert.match(read(f), /팀 메신저/, `${f} 메신저 절`);
});

test('빌드 결함 핀(v0.1.0 실사고): React 사본 dedupe, 설치파일은 dist 밖(installers/)·공백 없는 이름', () => {
  const vc = read('apps/messenger/vite.config.js');
  assert.match(vc, /dedupe: \['react', 'react-dom'\]/, "@argo/* 별칭이 루트 react를 끌어와 React가 둘 실린다 → 'useState' of null 빈 화면");
  const y = read('.github/workflows/release-messenger.yml');
  assert.match(y, /mkdir -p installers/); assert.match(y, /path: apps\/messenger\/installers\/\*/);
  assert.doesNotMatch(y, /path: apps\/messenger\/dist\/\*/, 'dist/는 Vite 산출물 — index.html·assets가 릴리스에 섞인다');
  assert.match(y, /sed 's\/Argo Messenger\/argo-messenger\/'/, '공백 파일명은 GitHub 자산명에서 점으로 바뀌어 latest.json과 어긋난다');
});
