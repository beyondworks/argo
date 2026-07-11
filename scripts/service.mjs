#!/usr/bin/env node
// Argo 상주 서비스 설치기 — 설치하는 누구나 한 명령으로 24시간 자동 운항.
//   npm run service install    # 지금 켜고, 재부팅·크래시에도 자동 재기동
//   npm run service status     # 서비스 등록 + 실제 응답 여부
//   npm run service logs       # 로그 위치 + 최근 로그
//   npm run service uninstall  # 상주 해제
//
// 플랫폼별 상주 메커니즘 (모두 사용자 권한 — sudo 불필요):
//   macOS   launchd LaunchAgent  (RunAtLoad + KeepAlive → 로그인 시 시작, 죽으면 10초 내 재기동)
//   Linux   systemd user unit + linger (Restart=always → 부팅 시 시작, 죽으면 재기동)
//   Windows 작업 스케줄러 ONLOGON + 감시 루프 cmd (죽으면 10초 후 재기동)
// 네트워크 단절 복구는 서버 안에서 해결된다 — 게이트웨이 폴러가 실패 시 5초 백오프로
// 무한 재시도(src/gateway.mjs), 서버 기동 즉시 폴러가 뜬다(instrumentation.js).
//
// 주의: node 경로를 설치 시점의 절대 경로로 굽는다(launchd는 셸 PATH가 없다).
//       nvm 등으로 node를 갈아끼웠다면 install을 다시 실행하면 된다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.ARGO_PORT || 3999);
const LABEL = 'com.beyondworks.argo';
const NODE = process.execPath;
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const cmd = process.argv[2] ?? 'status';

const sh = (file, args, opts = {}) => {
  try { return { ok: true, out: execFileSync(file, args, { encoding: 'utf8', ...opts }).trim() }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? e.message) }; }
};

function logPaths() {
  if (process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'Logs');
    return { dir, out: join(dir, 'argo.log'), err: join(dir, 'argo.err.log') };
  }
  const dir = join(homedir(), '.argo', 'logs');
  return { dir, out: join(dir, 'argo.log'), err: join(dir, 'argo.err.log') };
}

/** 프로덕션 빌드 보장 — standalone 잔재(.next가 데스크톱 빌드로 덮인 상태)면 next start가 어긋나므로 재빌드 */
function ensureBuild() {
  const stale = existsSync(join(ROOT, '.next', 'standalone'));
  if (existsSync(join(ROOT, '.next', 'BUILD_ID')) && !stale) return;
  console.log(`[argo] 프로덕션 빌드 실행${stale ? ' (standalone 잔재 정리)' : ''}...`);
  if (stale) rmSync(join(ROOT, '.next'), { recursive: true, force: true });
  const r = spawnSync(NODE, [NEXT_BIN, 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ARGO_STANDALONE: '' } });
  if (r.status !== 0) { console.error('[argo] 빌드 실패 — 서비스 설치를 중단합니다'); process.exit(1); }
}

async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/companies`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch { return false; }
}

/* ─── macOS: launchd LaunchAgent ─── */
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
function darwinInstall() {
  const { dir, out, err } = logPaths();
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });
  const env = { NODE_ENV: 'production', PATH: `${dirname(NODE)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` };
  if (process.env.ARGO_ROOT) env.ARGO_ROOT = process.env.ARGO_ROOT; // 설치 시점 데이터 루트를 굽는다
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>${NEXT_BIN}</string><string>start</string><string>-p</string><string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrPath</key><string>${err}</string>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${v}</string>`).join('\n')}
  </dict>
</dict></plist>
`;
  writeFileSync(plistPath(), plist);
  const uid = process.getuid();
  sh('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); // 재설치 대비 — 실패 무시
  const r = sh('launchctl', ['bootstrap', `gui/${uid}`, plistPath()]);
  if (!r.ok) { // 구형 macOS 폴백
    const legacy = sh('launchctl', ['load', '-w', plistPath()]);
    if (!legacy.ok) { console.error('[argo] launchd 등록 실패:', r.out || legacy.out); process.exit(1); }
  }
}
const darwinUninstall = () => {
  sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  rmSync(plistPath(), { force: true });
};
const darwinRegistered = () => sh('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).ok;

/* ─── Linux: systemd user unit + linger(로그아웃해도 유지) ─── */
const unitPath = () => join(homedir(), '.config', 'systemd', 'user', 'argo.service');
function linuxInstall() {
  const { dir, out, err } = logPaths();
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(unitPath()), { recursive: true });
  const extraEnv = process.env.ARGO_ROOT ? `Environment=ARGO_ROOT=${process.env.ARGO_ROOT}\n` : '';
  writeFileSync(unitPath(), `[Unit]
Description=Argo — AI crew company server
After=network-online.target

[Service]
ExecStart=${NODE} ${NEXT_BIN} start -p ${PORT}
WorkingDirectory=${ROOT}
Restart=always
RestartSec=10
Environment=NODE_ENV=production
${extraEnv}StandardOutput=append:${out}
StandardError=append:${err}

[Install]
WantedBy=default.target
`);
  sh('systemctl', ['--user', 'daemon-reload']);
  const r = sh('systemctl', ['--user', 'enable', '--now', 'argo']);
  if (!r.ok) { console.error('[argo] systemd 등록 실패:', r.out); process.exit(1); }
  const linger = sh('loginctl', ['enable-linger', process.env.USER ?? '']);
  if (!linger.ok) console.log('[argo] 참고: linger 설정 실패 — 로그아웃 중에도 돌리려면 `loginctl enable-linger`를 수동 실행하세요');
}
const linuxUninstall = () => { sh('systemctl', ['--user', 'disable', '--now', 'argo']); rmSync(unitPath(), { force: true }); sh('systemctl', ['--user', 'daemon-reload']); };
const linuxRegistered = () => sh('systemctl', ['--user', 'is-enabled', 'argo']).ok;

/* ─── Windows: 작업 스케줄러 + 감시 루프 cmd ─── */
const winCmdPath = () => join(ROOT, 'argo-service.cmd');
function winInstall() {
  const { dir, out } = logPaths();
  mkdirSync(dir, { recursive: true });
  // schtasks는 재시작을 못 하므로 cmd 안에서 무한 감시 루프 — 죽으면 10초 후 재기동
  writeFileSync(winCmdPath(), `@echo off\r
cd /d "${ROOT}"\r
set NODE_ENV=production\r
:loop\r
"${NODE}" "${NEXT_BIN}" start -p ${PORT} >> "${out}" 2>&1\r
timeout /t 10 /nobreak >nul\r
goto loop\r
`);
  const r = sh('schtasks', ['/Create', '/F', '/TN', 'Argo', '/SC', 'ONLOGON', '/TR', `"${winCmdPath()}"`]);
  if (!r.ok) { console.error('[argo] 작업 스케줄러 등록 실패:', r.out); process.exit(1); }
  sh('schtasks', ['/Run', '/TN', 'Argo']); // 지금 즉시 1회 기동
}
const winUninstall = () => { sh('schtasks', ['/End', '/TN', 'Argo']); sh('schtasks', ['/Delete', '/F', '/TN', 'Argo']); rmSync(winCmdPath(), { force: true }); };
const winRegistered = () => sh('schtasks', ['/Query', '/TN', 'Argo']).ok;

/* ─── 명령 라우팅 ─── */
const impl = {
  darwin: { install: darwinInstall, uninstall: darwinUninstall, registered: darwinRegistered },
  linux: { install: linuxInstall, uninstall: linuxUninstall, registered: linuxRegistered },
  win32: { install: winInstall, uninstall: winUninstall, registered: winRegistered },
}[process.platform];
if (!impl) { console.error(`[argo] 미지원 플랫폼: ${process.platform}`); process.exit(1); }

if (cmd === 'install') {
  ensureBuild();
  impl.install();
  process.stdout.write(`[argo] 서비스 등록 완료 — 응답 대기`);
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { // 콜드 스타트 최대 60초 대기
    await new Promise((r) => setTimeout(r, 2000));
    up = await probe();
    process.stdout.write('.');
  }
  console.log(up
    ? `\n[argo] 가동 확인 — http://localhost:${PORT} (재부팅·크래시 자동 복구 활성)`
    : `\n[argo] 아직 응답이 없습니다 — \`npm run service logs\`로 확인하세요`);
} else if (cmd === 'uninstall') {
  impl.uninstall();
  console.log('[argo] 상주 해제 완료');
} else if (cmd === 'logs') {
  const { out, err } = logPaths();
  console.log(`로그: ${out}\n에러: ${err}\n--- 최근 로그 ---`);
  for (const p of [out, err]) {
    try { console.log(readFileSync(p, 'utf8').split('\n').slice(-15).join('\n')); } catch { /* 아직 없음 */ }
  }
} else { // status
  const reg = impl.registered();
  const up = await probe();
  console.log(`서비스 등록: ${reg ? '예' : '아니오'}\n서버 응답(포트 ${PORT}): ${up ? '정상' : '없음'}`);
  process.exit(reg && up ? 0 : 1);
}
