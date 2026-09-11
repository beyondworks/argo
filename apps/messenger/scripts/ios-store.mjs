// App Store Connect(TestFlight)용 iOS 빌드·업로드. API 키 없이 Xcode에 로그인된 계정 세션을 쓴다(-allowProvisioningUpdates).
//   node scripts/ios-store.mjs build [빌드번호]   # release 아카이브 + app-store-connect 내보내기 → src-tauri/gen/apple/build/arm64/*.ipa
//   node scripts/ios-store.mjs upload   # 위 아카이브를 App Store Connect로 업로드
// 클라우드 설정 파일(VITE_*)은 자식 프로세스 env로만 넘기고 값은 어디에도 출력하지 않는다.
// 러스트 툴체인은 RUSTUP_HOME/CARGO_HOME이 있으면 그대로, 없으면 레포 루트의 artifacts/mobile-native 를 쓴다.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(app, '../..');
const apple = join(app, 'src-tauri/gen/apple');
const mode = process.argv[2];

export const parseEnv = (text) => Object.fromEntries(
  text.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);

export const buildEnv = (base, config = {}) => {
  const env = { ...base, ...config };
  delete env.VITE_DEV_LOGIN; // 스토어 빌드엔 개발용 비밀번호 로그인 없음
  env.RUSTUP_HOME ||= join(root, 'artifacts/mobile-native/rustup');
  env.CARGO_HOME ||= join(root, 'artifacts/mobile-native/cargo');
  env.PATH = `${env.RUSTUP_HOME}/toolchains/stable-aarch64-apple-darwin/bin:${env.CARGO_HOME}/bin:${env.PATH}`; // Xcode 스크립트 단계가 rustup을 찾는다
  return env;
};

// 업로드용 ExportOptions: destination=upload 가 Xcode 계정 세션으로 App Store Connect에 올린다.
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
//  ① CFBundleURLSchemes에 로그인 복귀 스킴 ② 버전 = tauri.conf.json ③ 수출 규정 면제 키. 하나라도 빠지면 업로드하지 않는다.
export const LOGIN_SCHEME = 'argo-messenger';
export function ipaGate(info, { version, scheme = LOGIN_SCHEME } = {}) {
  const problems = [];
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
  if (!schemes.includes(scheme)) problems.push(`CFBundleURLTypes에 ${scheme} 스킴 없음(브라우저 로그인 복귀 불가)`);
  if (version && info.CFBundleShortVersionString !== version) problems.push(`버전 불일치: ipa ${info.CFBundleShortVersionString} ≠ conf ${version}`);
  if (info.ITSAppUsesNonExemptEncryption !== false) problems.push('ITSAppUsesNonExemptEncryption=false 없음(수출 규정 질문이 뜬다)');
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
  const env = buildEnv(process.env, existsSync(configFile) ? parseEnv(readFileSync(configFile, 'utf8')) : {});
  if (!existsSync(join(env.CARGO_HOME, 'bin/rustup'))) throw new Error(`rustup 없음: ${env.CARGO_HOME}/bin — RUSTUP_HOME/CARGO_HOME을 지정하세요`);
  const buildNumber = process.argv[3]; // 같은 버전을 다시 올릴 때(예: 2) — TestFlight는 빌드 번호가 달라야 받는다
  run('npm', ['run', 'mobile:ios:build', '--', '--export-method', 'app-store-connect', '--target', 'aarch64', '--ci', ...(buildNumber ? ['--build-number', String(buildNumber)] : [])], env);
  gateOrDie('build');
} else if (mode === 'upload') {
  gateOrDie('upload');
  const archive = join(apple, 'build/argo-messenger_iOS.xcarchive');
  if (!existsSync(archive)) throw new Error(`아카이브 없음: ${archive} — 먼저 build`);
  const team = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.ios.conf.json'), 'utf8')).bundle.iOS.developmentTeam;
  const plist = join(mkdtempSync(join(tmpdir(), 'ios-store-')), 'upload.plist');
  writeFileSync(plist, uploadPlist(team));
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', plist, '-exportPath', join(apple, 'build/upload'), '-allowProvisioningUpdates'], process.env);
} else if (mode === 'check') {
  gateOrDie('check');
} else if (mode !== undefined) {
  console.error('usage: node scripts/ios-store.mjs build|upload|check');
  process.exit(2);
}
