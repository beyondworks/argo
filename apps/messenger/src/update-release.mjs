// 순수 로직 — 데스크톱·모바일 업데이터가 공유하는 부분. GitHub 릴리스 메타 해석·자산 고르기·호스트 허용 목록·버전 비교.
// 어떤 브라우저·네트워크 호출도 하지 않는다(부작용은 update.jsx/mobile-update.jsx가 가진다) — 여기는 테스트로 잠근다.

// x.y.z만 받는다(프리릴리스·빌드메타 태그는 비교 대상 밖 — 이 레포는 태그가 항상 순수 버전이다).
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** a가 b보다 새 버전이면 1, 같으면 0, 낮으면 -1. 파싱 실패는 비교 불가(null)로 — 추측해서 새 버전이라 우기지 않는다. */
export function compareSemver(a, b) {
  const pa = parseSemver(a); const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

export function isNewer(remoteVersion, currentVersion) {
  return compareSemver(remoteVersion, currentVersion) === 1;
}

// 자산·릴리스 URL은 이 호스트에서만 받는다 — 릴리스 API 응답이 가리키는 곳이 엉뚱한 서버여도(가정: 응답 변조) 따라가지 않는다.
// objects.githubusercontent.com은 GitHub가 릴리스 자산을 실제로 서빙하는 리다이렉트 목적지(302 Location).
export const ALLOWED_ASSET_HOSTS = ['github.com', 'api.github.com', 'objects.githubusercontent.com'];

export function isAllowedHost(url) {
  try { return ALLOWED_ASSET_HOSTS.includes(new URL(url).host); } catch { return false; }
}

/** GitHub REST의 releases/latest 응답에서 필요한 것만 뽑는다. digest는 GitHub가 자산 업로드 시 직접 계산해 응답에 싣는 sha256 —
 *  별도 체크섬 파일 없이 이것으로 다운로드 무결성을 댄다(레포에 없으면 어차피 없는 것 — 있는 필드를 쓴다). */
export function parseGithubRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const version = parseSemver(json.tag_name) ? String(json.tag_name).replace(/^v/, '') : null;
  if (!version) return null;
  const assets = Array.isArray(json.assets) ? json.assets
    .filter((a) => a && typeof a.name === 'string' && typeof a.url === 'string' && isAllowedHost(a.url))
    .map((a) => ({ name: a.name, url: a.url, contentType: a.content_type ?? '', size: a.size ?? 0, sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null }))
    : [];
  return { version, htmlUrl: typeof json.html_url === 'string' ? json.html_url : '', assets };
}

/** Android APK 자산 — 이름 규칙은 발행 스킬의 실제 관행(argo-messenger-<ver>-android.apk)을 따르되,
 *  버전이 바뀌어도 고르도록 접미사·MIME 둘 다로 판정한다(둘 중 하나만 맞아도 채택). */
export function pickAndroidAsset(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find((a) => /-android\.apk$/i.test(a.name) || a.contentType === 'application/vnd.android.package-archive') ?? null;
}
