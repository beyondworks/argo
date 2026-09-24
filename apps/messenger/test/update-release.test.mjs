import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver, isNewer, isAllowedHost, parseGithubRelease, pickAndroidAsset, ALLOWED_ASSET_HOSTS } from '../src/update-release.mjs';

test('semver 비교 — 파싱 실패는 비교 불가(null), 실제 태그 모양(v접두)도 받는다', () => {
  assert.equal(compareSemver('0.1.39', '0.1.38'), 1);
  assert.equal(compareSemver('v0.1.38', '0.1.38'), 0);
  assert.equal(compareSemver('0.1.9', '0.2.0'), -1);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  assert.equal(compareSemver('0.1.38', '0.1.38'), 0);
  assert.equal(compareSemver('garbage', '0.1.38'), null);
  assert.equal(compareSemver('0.1.38', ''), null);
  assert.equal(isNewer('0.1.39', '0.1.38'), true);
  assert.equal(isNewer('0.1.38', '0.1.38'), false);
  assert.equal(isNewer('0.1.37', '0.1.38'), false);
  assert.equal(isNewer('bogus', '0.1.38'), false, '파싱 실패를 새 버전으로 우기지 않는다');
  assert.equal(parseSemver('0.10.2').minor, 10, '두 자리 숫자도 자릿수 비교가 아니라 정수 비교');
});

test('허용 호스트 — github.com·api.github.com·release-assets.githubusercontent.com만, 그 외는 전부 거부', () => {
  assert.equal(isAllowedHost('https://github.com/beyondworks/argo-messenger/releases/download/v0.1.38/x.apk'), true);
  assert.equal(isAllowedHost('https://release-assets.githubusercontent.com/foo'), true, '실측(2026-09-24): octet-stream 요청의 302 목적지');
  assert.equal(isAllowedHost('https://api.github.com/repos/x'), true);
  assert.equal(isAllowedHost('https://objects.githubusercontent.com/foo'), false, '이 릴리스 자산 경로의 실제 리다이렉트 목적지가 아니다');
  assert.equal(isAllowedHost('https://evil.example.com/argo-messenger-android.apk'), false);
  assert.equal(isAllowedHost('https://github.com.evil.example.com/x'), false, '호스트 접두 위장 거부');
  assert.equal(isAllowedHost('not a url'), false);
  assert.deepEqual(ALLOWED_ASSET_HOSTS, ['github.com', 'api.github.com', 'release-assets.githubusercontent.com']);
});

test('GitHub 릴리스 JSON 해석 — 실제 v0.1.38 응답 모양(url=api.github.com 자산 id, digest 필드)을 그대로 해석한다', () => {
  const json = {
    tag_name: 'v0.1.38',
    html_url: 'https://github.com/beyondworks/argo-messenger/releases/tag/v0.1.38',
    assets: [
      { name: 'argo-messenger-0.1.38-android.apk', url: 'https://api.github.com/repos/beyondworks/argo-messenger/releases/assets/585817095', content_type: 'application/vnd.android.package-archive', size: 51984339, digest: 'sha256:514ecd831cade312abf9c937b75a5156243dfddc39a3c3e56bec2cd8c120352e' },
      { name: 'argo-messenger-macos-apple-silicon.dmg', url: 'https://api.github.com/repos/beyondworks/argo-messenger/releases/assets/585817091', content_type: 'application/x-apple-diskimage', size: 1, digest: 'sha256:abc' },
      { name: 'evil.apk', url: 'https://evil.example.com/evil.apk', content_type: 'application/vnd.android.package-archive', size: 1, digest: null },
    ],
  };
  const parsed = parseGithubRelease(json);
  assert.equal(parsed.version, '0.1.38');
  assert.equal(parsed.assets.length, 2, '허용 호스트 밖 자산은 걸러낸다');
  const apk = pickAndroidAsset(parsed.assets);
  assert.equal(apk.name, 'argo-messenger-0.1.38-android.apk');
  assert.equal(apk.sha256, '514ecd831cade312abf9c937b75a5156243dfddc39a3c3e56bec2cd8c120352e');
  assert.equal(pickAndroidAsset([]), null);
  assert.equal(pickAndroidAsset(null), null);
  assert.equal(parseGithubRelease(null), null);
  assert.equal(parseGithubRelease({ tag_name: 'not-a-version' }), null);
  assert.equal(parseGithubRelease({}), null);
});

test('APK 자산 고르기 — 이름 접미사와 MIME 둘 중 하나만 맞아도 채택(둘 다 아니면 제외)', () => {
  assert.equal(pickAndroidAsset([{ name: 'weird-name.bin', url: 'https://github.com/x', contentType: 'application/vnd.android.package-archive' }])?.name, 'weird-name.bin');
  assert.equal(pickAndroidAsset([{ name: 'foo-android.apk', url: 'https://github.com/x', contentType: 'application/octet-stream' }])?.name, 'foo-android.apk');
  assert.equal(pickAndroidAsset([{ name: 'latest.json', url: 'https://github.com/x', contentType: 'application/json' }]), null);
});
