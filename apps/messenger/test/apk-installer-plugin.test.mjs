// apk-installer 네이티브 플러그인(Kotlin) 안전장치 — Kotlin 테스트 러너가 없는 레포라 소스 대조로 잠근다
// (ios-store.test.mjs가 Info.plist를 대조하는 것과 같은 관례). 분리 검수 HIGH/MEDIUM 반영(2026-09-24).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const kt = readFileSync(new URL('../src-tauri/plugins/apk-installer/android/src/main/java/com/beyondworks/argo/messenger/apkinstaller/ApkInstallerPlugin.kt', import.meta.url), 'utf8');
const gradle = readFileSync(new URL('../src-tauri/plugins/apk-installer/android/build.gradle.kts', import.meta.url), 'utf8');
const appGradle = readFileSync(new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url), 'utf8');

test('플러그인 minSdk는 앱과 같다 — 다르면 매니페스트 병합이 실패한다(실사고 2026-09-24)', () => {
  const pluginMinSdk = gradle.match(/minSdk = (\d+)/)?.[1];
  const appMinSdk = appGradle.match(/minSdk = (\d+)/)?.[1];
  assert.ok(pluginMinSdk && appMinSdk, '두 build.gradle.kts 모두 minSdk를 선언해야 한다');
  assert.equal(pluginMinSdk, appMinSdk, `플러그인 minSdk(${pluginMinSdk}) != 앱 minSdk(${appMinSdk})`);
});

test('API 26 미만 기기에서도 죽지 않는다 — canRequestPackageInstalls·ACTION_MANAGE_UNKNOWN_APP_SOURCES는 Build.VERSION으로 막는다', () => {
  assert.match(kt, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.O \|\| activity\.packageManager\.canRequestPackageInstalls\(\)/);
  assert.match(kt, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O\) \{[\s\S]{0,120}ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
});

test('실제 리다이렉트 목적지(release-assets.githubusercontent.com)만 허용 — objects.githubusercontent.com이 아니다', () => {
  assert.match(kt, /private val ALLOWED_HOSTS = setOf\("github\.com", "api\.github\.com", "release-assets\.githubusercontent\.com"\)/);
});

test('시작 URL은 api.github.com 자산 id 접두사로 고정, https만 따라가며 매 홉 호스트를 재검사한다', () => {
  assert.match(kt, /private const val REQUIRED_URL_PREFIX = "https:\/\/api\.github\.com\/repos\/beyondworks\/argo-messenger\/releases\/assets\/"/);
  assert.match(kt, /if \(!args\.url\.startsWith\(REQUIRED_URL_PREFIX\)\)/);
  assert.match(kt, /if \(current\.protocol != "https"\) throw SecurityException/);
  assert.match(kt, /if \(current\.host !in ALLOWED_HOSTS\) throw SecurityException/);
});

test('api.github.com 자산 엔드포인트는 Accept: application/octet-stream 없이는 JSON을 준다 — 헤더를 보낸다', () => {
  assert.match(kt, /conn\.setRequestProperty\("Accept", "application\/octet-stream"\)/);
});

test('sha256은 필수 — 없으면 다운로드 자체를 시작하지 않는다(설치 안 하는 정도가 아니라)', () => {
  assert.match(kt, /if \(args\.sha256\.isNullOrBlank\(\)\) \{ invoke\.reject\(.*"SHA256_REQUIRED"\); return \}/);
});

test('설치 권한 확인은 다운로드 시작보다 먼저다', () => {
  const permIdx = kt.indexOf('if (!canRequestInstalls())');
  const threadIdx = kt.indexOf('Thread {');
  assert.ok(permIdx > -1 && threadIdx > -1 && permIdx < threadIdx, '권한 검사가 Thread 시작보다 먼저 나와야 한다(소스 순서)');
});

test('더블탭 방지 — 다운로드 중이면 새 요청은 즉시 거부', () => {
  assert.match(kt, /private val downloading = AtomicBoolean\(false\)/);
  assert.match(kt, /if \(!downloading\.compareAndSet\(false, true\)\) \{ invoke\.reject\(.*"ALREADY_DOWNLOADING"\); return \}/);
  assert.match(kt, /downloading\.set\(false\)/);
});

test('파일명은 매 다운로드마다 고유하고, 설치 화면을 연 뒤 이전 파일을 지운다', () => {
  assert.match(kt, /File\(dir, "update-\$\{System\.currentTimeMillis\(\)\}\.apk"\)/);
  assert.match(kt, /startInstall\(file\)\s*\n\s*cleanupOtherDownloads\(file\)/);
});
