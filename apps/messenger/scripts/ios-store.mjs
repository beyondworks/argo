// App Store Connect(TestFlight)용 iOS 빌드·업로드. 인증은 App Store Connect API 키(아래 readAscKey), 없으면 Xcode 계정 세션(-allowProvisioningUpdates).
//   node scripts/ios-store.mjs build [빌드번호]   # release 아카이브 + app-store-connect 내보내기 → src-tauri/gen/apple/build/arm64/*.ipa
//   node scripts/ios-store.mjs upload   # 위 아카이브를 App Store Connect로 업로드
// 클라우드 설정 파일(VITE_*)은 자식 프로세스 env로만 넘기고 값은 어디에도 출력하지 않는다.
// 러스트 툴체인은 RUSTUP_HOME/CARGO_HOME이 있으면 그대로, 없으면 레포 루트의 artifacts/mobile-native 를 쓴다.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(app, '../..');
const apple = join(app, 'src-tauri/gen/apple');
const ARCHIVE = join(apple, 'build/argo-messenger_iOS.xcarchive'); const STAMP = join(apple, 'build/.upload-stamp.json');
const mode = process.argv[2];

export const parseEnv = (text) => Object.fromEntries(
  text.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);

// 서명 팀 ID는 커밋된 pbxproj에 없다(개인 값) — 빌드 전에 tauri.ios.conf.json의 developmentTeam을 두 구성(debug·release)에 넣는다.
// 실사고 2026-09-15: 빌드 뒤 pbxproj를 원복하면서 손으로 넣어 둔 팀 줄이 사라져 "requires a development team"으로 실패.
export const ensureTeam = (pbxproj, team) => { // 결정적: 기존 팀 줄(따옴표 유무·들여쓰기 무관)을 전부 걷어내고 VALID_ARCHS마다 하나씩 넣는다(검수 M-1·M-2: 한쪽만 있거나 따옴표 없는 줄이 남던 것)
  if (!team) return pbxproj;
  const stripped = pbxproj.replace(/^[\t ]*DEVELOPMENT_TEAM = .*;\n/gm, '');
  return stripped.replace(/^([\t ]*)VALID_ARCHS = arm64;\n/gm, (m, indent) => `${m}${indent}DEVELOPMENT_TEAM = "${team}";\n`);
};
// 업로드 도장: build가 성공한 아카이브에만 찍고, upload는 도장이 그 아카이브를 가리킬 때만 올린 뒤 도장을 지운다.
// 실사고 2026-09-15: 빌드가 실패했는데 upload가 그대로 돌아 폴더에 남아 있던 옛 아카이브가 TestFlight "0.1.26 (1)"로 올라갔다.
export const stampMatches = (stamp, archiveMtimeMs) => !!stamp && Number.isFinite(stamp.archiveMtimeMs) && stamp.archiveMtimeMs === archiveMtimeMs;

export const buildEnv = (base, config = {}) => {
  const env = { ...base, ...config };
  delete env.VITE_DEV_LOGIN; // 스토어 빌드엔 개발용 비밀번호 로그인 없음
  env.RUSTUP_HOME ||= join(root, 'artifacts/mobile-native/rustup');
  env.CARGO_HOME ||= join(root, 'artifacts/mobile-native/cargo');
  env.PATH = `${env.RUSTUP_HOME}/toolchains/stable-aarch64-apple-darwin/bin:${env.CARGO_HOME}/bin:${env.PATH}`; // Xcode 스크립트 단계가 rustup을 찾는다
  return env;
};

export const ensureSwiftLinkTools = (env, { spawn = spawnSync, exists = existsSync } = {}) => {
  const output = (cmd, args) => {
    const r = spawn(cmd, args, { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`[ios-store] ${cmd} 확인 실패 — iOS 빌드 도구를 확인하세요`);
    return r.stdout.trim();
  };
  const major = Number(output('xcodebuild', ['-version']).match(/^Xcode (\d+)/)?.[1]);
  if (!major) throw new Error('[ios-store] Xcode 버전을 확인할 수 없습니다');
  if (major < 27) return;
  const sysroot = output('rustc', ['--print', 'sysroot']);
  const host = output('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
  if (!sysroot || !host) throw new Error('[ios-store] Rust 툴체인을 확인할 수 없습니다');
  if (!exists(join(sysroot, 'lib/rustlib', host, 'bin/llvm-objcopy'))) {
    throw new Error('[ios-store] Xcode 27의 Swift 링크에 llvm-tools가 필요합니다. 빌드와 같은 RUSTUP_HOME·RUSTUP_TOOLCHAIN으로 rustup component add llvm-tools를 실행하세요');
  }
};

// App Store Connect API 키(팀 키, **관리자** — '앱 관리' 키는 클라우드 배포 인증서 권한이 없어 export가 "Cloud signing permission error"로 실패, 실측 2026-09-17) — Xcode 계정 세션이 풀려도(실사고 2026-09-11·09-17 "No Accounts") 서명·업로드가 된다.
// 설정 파일(기본 ~/.appstoreconnect/argo-messenger.json, ASC_API_CONFIG로 바꿈) = { keyId, issuerId, keyPath }. 레포 밖 비공개 파일이고 값은 출력하지 않는다.
// 없으면 종전처럼 Xcode 계정 세션을 쓴다. tauri ios build는 APPLE_API_KEY·APPLE_API_ISSUER·APPLE_API_KEY_PATH로 같은 키를 쓴다.
export const readAscKey = (text) => {
  let c; try { c = JSON.parse(text); } catch { return null; }
  return c && /^[A-Z0-9]{10}$/.test(c.keyId ?? '') && /^[0-9a-f-]{36}$/.test(c.issuerId ?? '') && typeof c.keyPath === 'string' && c.keyPath ? c : null;
};
export const ascBuildEnv = (key) => key ? { APPLE_API_KEY: key.keyId, APPLE_API_ISSUER: key.issuerId, APPLE_API_KEY_PATH: key.keyPath } : {};
export const ascExportArgs = (key) => key ? ['-authenticationKeyPath', key.keyPath, '-authenticationKeyID', key.keyId, '-authenticationKeyIssuerID', key.issuerId] : [];
const ascKey = () => {
  const p = process.env.ASC_API_CONFIG || join(process.env.HOME ?? '', '.appstoreconnect/argo-messenger.json');
  if (!existsSync(p)) return null;
  const key = readAscKey(readFileSync(p, 'utf8'));
  if (!key || !existsSync(key.keyPath)) throw new Error(`App Store Connect API 설정이 잘못됐다: ${p} (keyId·issuerId·keyPath 확인)`);
  return key;
};

// 업로드용 ExportOptions: destination=upload 가 App Store Connect에 올린다(인증 = API 키 또는 Xcode 계정 세션).
export const uploadPlist = (teamID) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${teamID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
`;

// 발행 게이트(실사고 2026-09-11: 스킴 없는 ipa가 0.1.4~0.1.6에 나가 브라우저 로그인 복귀가 죽었다) — 내보낸 ipa의 Info.plist를 직접 검사한다.
//  ① CFBundleURLSchemes에 로그인 복귀 스킴 ② 버전 = tauri.conf.json ③ 수출 규정 면제 키 ④ UIDeviceFamily=[1](iPhone 전용 — TARGETED_DEVICE_FAMILY는 Tauri가
//  관리하지 않는 Xcode 설정이라 `tauri ios init` 재생성에 되돌아갈 수 있다, 검수 #532 M-3). 하나라도 빠지면 업로드하지 않는다.
export const LOGIN_SCHEME = 'argo-messenger';
export const USAGE_KEYS = ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSMicrophoneUsageDescription'];
export function ipaGate(info, { version, scheme = LOGIN_SCHEME } = {}) {
  const problems = [];
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
  if (!schemes.includes(scheme)) problems.push(`CFBundleURLTypes에 ${scheme} 스킴 없음(브라우저 로그인 복귀 불가)`);
  if (version && info.CFBundleShortVersionString !== version) problems.push(`버전 불일치: ipa ${info.CFBundleShortVersionString} ≠ conf ${version}`);
  if (info.ITSAppUsesNonExemptEncryption !== false) problems.push('ITSAppUsesNonExemptEncryption=false 없음(수출 규정 질문이 뜬다)');
  if (JSON.stringify(info.UIDeviceFamily ?? null) !== '[1]') problems.push(`UIDeviceFamily가 [1]이 아님(${JSON.stringify(info.UIDeviceFamily ?? null)}) — iPhone 전용 선언(TARGETED_DEVICE_FAMILY=1)이 빠졌거나 되돌아갔다`);
  // ⑤ 씬 생명주기(실사고 2026-09-17: Xcode 27·iOS 27 SDK로 빌드한 0.1.27이 씬 설정 없이 나가 iOS 27에서 실행 즉시 죽었다). tao는 이 값이 true여야 씬 모드로 붙는다
  if (info.UIApplicationSceneManifest?.UIApplicationSupportsMultipleScenes !== true) problems.push('UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes=true 없음(iOS 27에서 실행 즉시 종료)');
  // 실사고 2026-09-26: 권한 설명 문구 없이 나간 0.1.39가 iPad 심사에서 '사진 찍기' 탭 즉시 TCC 강제 종료(2.1 거절). 첨부 버튼(<input type=file>)이
  // 카메라·사진 보관함·동영상(마이크) 메뉴를 띄우므로 셋 다 있어야 한다.
  for (const k of USAGE_KEYS) if (!String(info[k] ?? '').trim()) problems.push(`${k} 없음(첨부 메뉴에서 앱이 강제 종료된다)`);
  return problems;
}
const ipaInfo = (ipa) => {
  const dir = mkdtempSync(join(tmpdir(), 'ipa-gate-'));
  const r = spawnSync('unzip', ['-q', '-o', ipa, '-d', dir]); if (r.status !== 0) throw new Error('ipa 압축 해제 실패');
  const app = readdirSync(join(dir, 'Payload')).find((n) => n.endsWith('.app'));
  const out = spawnSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'Payload', app, 'Info.plist')], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error('Info.plist 읽기 실패');
  return JSON.parse(out.stdout);
};
const gateOrDie = (label) => {
  const ipa = join(apple, 'build/arm64/Argo Messenger.ipa');
  if (!existsSync(ipa)) throw new Error(`ipa 없음: ${ipa}`);
  const version = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  const problems = ipaGate(ipaInfo(ipa), { version });
  if (problems.length) { console.error(`[ios-store] ${label} 게이트 실패:\n - ${problems.join('\n - ')}`); process.exit(3); }
  console.log(`[ios-store] ${label} 게이트 통과: 스킴 ${LOGIN_SCHEME} · 버전 ${version} · 암호화 면제`);
};

const run = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { cwd: app, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (mode === 'build') {
  const configFile = join(app, '.env.local');
  const env = { ...buildEnv(process.env, existsSync(configFile) ? parseEnv(readFileSync(configFile, 'utf8')) : {}), ...ascBuildEnv(ascKey()) };
  if (!existsSync(join(env.CARGO_HOME, 'bin/rustup'))) throw new Error(`rustup 없음: ${env.CARGO_HOME}/bin — RUSTUP_HOME/CARGO_HOME을 지정하세요`);
  const buildNumber = process.argv[3]; // 같은 버전을 다시 올릴 때(예: 2) — TestFlight는 빌드 번호가 달라야 받는다
  const pbx = join(apple, 'argo-messenger.xcodeproj/project.pbxproj'); const team = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.ios.conf.json'), 'utf8')).bundle.iOS.developmentTeam;
  const before = readFileSync(pbx, 'utf8'); const after = ensureTeam(before, team); if (after !== before) writeFileSync(pbx, after);
  try { unlinkSync(STAMP); } catch { /* 없으면 그만 */ }
  ensureSwiftLinkTools(env);
  run('npm', ['run', 'mobile:ios:build', '--', '--export-method', 'app-store-connect', '--target', 'aarch64', '--ci', ...(buildNumber ? ['--build-number', String(buildNumber)] : [])], env);
  gateOrDie('build');
  writeFileSync(STAMP, JSON.stringify({ archiveMtimeMs: statSync(ARCHIVE).mtimeMs, buildNumber: buildNumber ?? null, at: new Date().toISOString() }));
} else if (mode === 'upload') {
  gateOrDie('upload');
  const archive = ARCHIVE; const stampPath = STAMP;
  if (!existsSync(archive)) throw new Error(`아카이브 없음: ${archive} — 먼저 build`);
  let stamp = null; try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')); } catch { /* 도장 없음 */ }
  if (!stampMatches(stamp, statSync(archive).mtimeMs)) { console.error('[ios-store] 이 아카이브는 방금 성공한 build의 것이 아닙니다(도장 없음·불일치) — 옛 아카이브가 올라가는 것을 막습니다. 먼저 build.'); process.exit(4); }
  const team = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.ios.conf.json'), 'utf8')).bundle.iOS.developmentTeam;
  const plist = join(mkdtempSync(join(tmpdir(), 'ios-store-')), 'upload.plist');
  writeFileSync(plist, uploadPlist(team));
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', plist, '-exportPath', join(apple, 'build/upload'), '-allowProvisioningUpdates', ...ascExportArgs(ascKey())], process.env);
  try { unlinkSync(stampPath); } catch { /* 이미 없음 */ } // 같은 아카이브를 두 번 올리지 않는다
} else if (mode === 'check') {
  gateOrDie('check');
} else if (mode !== undefined) {
  console.error('usage: node scripts/ios-store.mjs build|upload|check');
  process.exit(2);
}
