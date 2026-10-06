// media-share 기기 플러그인(2026-10-02) — 모바일 첨부 저장·공유. Kotlin·Swift 테스트 러너가 없는 레포라 연결과 안전장치를 소스 대조로 잠근다
// (apk-installer-plugin.test.mjs·ios-store.test.mjs와 같은 관례). 실기기 동작은 이 테스트가 보장하지 않는다(보고서에 미확인으로 적는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const kt = read('src-tauri/plugins/media-share/android/src/main/java/com/beyondworks/argo/messenger/mediashare/MediaSharePlugin.kt');
const swift = read('src-tauri/plugins/media-share/ios/Sources/MediaSharePlugin.swift');
const rs = read('src-tauri/plugins/media-share/src/lib.rs');
const build = read('src-tauri/plugins/media-share/build.rs');
const gradle = read('src-tauri/plugins/media-share/android/build.gradle.kts');
const appGradle = read('src-tauri/gen/android/app/build.gradle.kts');
const appRs = read('src-tauri/src/lib.rs');
const cargo = read('src-tauri/Cargo.toml');
const mobileCap = JSON.parse(read('src-tauri/capabilities/mobile.json'));
const io = read('src/media-io.js');
const plist = read('src-tauri/gen/apple/argo-messenger_iOS/Info.plist');

test('JS가 부르는 명령(share·save·open) = 플러그인 명령 = 권한', () => {
  const used = [...new Set([...io.matchAll(/native\('(\w+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['open', 'save', 'share']);
  assert.match(build, /const COMMANDS: &\[&str\] = &\["share", "save", "open"\];/);
  assert.match(rs, /generate_handler!\[mobile::share, mobile::save, mobile::open\]/);
  assert.ok(mobileCap.permissions.includes('media-share:default'), '모바일 권한에 media-share:default');
  assert.match(io, /invoke\(`plugin:media-share\|\$\{cmd\}`/);
});

test('모바일에서만 등록 — 데스크톱 빌드에는 없다(데스크톱은 save_download 명령)', () => {
  assert.match(cargo, /\[target\.'cfg\(any\(target_os = "android", target_os = "ios"\)\)'\.dependencies\][\s\S]*tauri-plugin-media-share = \{ path = "plugins\/media-share" \}/);
  assert.match(appRs, /#\[cfg\(mobile\)\]\n\s*let builder = builder\.plugin\(tauri_plugin_media_share::init\(\)\);/);
  assert.match(rs, /register_android_plugin\("com\.beyondworks\.argo\.messenger\.mediashare", "MediaSharePlugin"\)/);
  assert.match(rs, /register_ios_plugin\(init_plugin_media_share\)/);
  assert.match(swift, /@_cdecl\("init_plugin_media_share"\)/);
});

test('Android — minSdk는 앱과 같고, API 29 전용 MediaStore는 버전으로 막고, 7~9는 공유 시트로', () => {
  assert.equal(gradle.match(/minSdk = (\d+)/)?.[1], appGradle.match(/minSdk = (\d+)/)?.[1]);
  assert.match(kt, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q\) saveToMediaStore\(file, mime\) else \{ startChooser\(sendIntent\(file, mime\)\); "share" \}/);
  assert.match(kt, /MediaStore\.MediaColumns\.IS_PENDING, 1/, '다 쓸 때까지 갤러리에 반쯤 쓴 파일이 보이지 않게');
  assert.match(kt, /resolver\.delete\(uri, null, null\)/, '실패하면 만든 항목을 지운다');
  assert.match(kt, /\$\{activity\.packageName\}\.fileprovider/, '앱 매니페스트의 FileProvider를 쓴다');
});

test('내려받기 안전장치 — http(s)만, 리다이렉트 3번, 25MB 상한(받는 도중에도), 이름 세척, 하루 지난 사본 정리', () => {
  assert.match(kt, /if \(current\.protocol != "https" && current\.protocol != "http"\) throw SecurityException/);
  assert.match(kt, /private const val MAX_REDIRECTS = 3/);
  assert.match(kt, /private const val MAX_BYTES = 26_214_400L/);
  assert.match(kt, /if \(total > MAX_BYTES\) \{ dir\.deleteRecursively\(\); throw IOException\("file too large"\) \}/);
  assert.match(kt, /substringAfterLast\('\/'\)\.substringAfterLast\('\\\\'\)/);
  assert.match(swift, /private let maxBytes: Int64 = 26_214_400/);
  assert.match(swift, /scheme == "https" \|\| scheme == "http"/);
  assert.match(swift, /static func safeName/);
  assert.match(swift, /addingTimeInterval\(-86_400\)/);
});

test('iOS — 사진은 추가 전용 권한(Info.plist 문구 필수), 파일은 내보내기, iPad 팝오버 기준점', () => {
  assert.match(swift, /PHPhotoLibrary\.requestAuthorization\(for: \.addOnly\)/);
  assert.match(plist, /<key>NSPhotoLibraryAddUsageDescription<\/key>\s*<string>[^<]+<\/string>/, '문구가 없으면 권한 요청 순간 앱이 종료된다');
  assert.match(swift, /UIDocumentPickerViewController\(forExporting: \[file\], asCopy: true\)/);
  assert.match(swift, /popoverPresentationController/);
  assert.match(swift, /case place = "where"/, 'JS가 읽는 결과 키는 where');
});
