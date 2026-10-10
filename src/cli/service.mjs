// argo run 상주 서비스 파일 — 값(경로·ARGO_ROOT)을 그대로 끼워 넣으면 XML·유닛 문법이 깨지거나 NODE_OPTIONS 같은 키가
// 몰래 추가된다(검수 2026-09-30). launchd는 XML 이스케이프, systemd는 제어 문자 거부 + 인용·% 처리.
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** 상주 실행 인자 — `argo service install [--standby|--no-prefer]`가 유닛·plist에 그대로 넣는다(전에는 'run'으로 고정돼 역할을 못 넣었다).
    예비(--standby): 다른 기기(맥)가 담당하지 않을 때만 맡는 서버. 일반(--no-prefer). 기본(우선): 항상 이 기기가 담당. 아는 값만 받는다. */
export const SERVICE_FLAGS = ['--standby', '--no-prefer'];
export function runArgs(flags = []) {
  const picked = SERVICE_FLAGS.filter((f) => flags.includes(f));
  return ['run', ...(picked.includes('--standby') ? ['--standby'] : picked)]; // 둘 다 주면 예비(가져가지 않는 쪽)
}
const safeArgs = (args) => {
  for (const a of args) if (!/^-{0,2}[a-z][a-z-]*$/.test(String(a))) throw new Error(`bad service argument: ${JSON.stringify(a)}`);
  return args;
};

export function launchdPlist({ label, node, bin, env, log, args = ['run'] }) {
  const s = (v) => `<string>${xml(v)}</string>`;
  const envXml = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key>${s(v)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key>${s(label)}<key>ProgramArguments</key><array>${s(node)}${s(bin)}${safeArgs(args).map(s).join('')}</array><key>EnvironmentVariables</key><dict>${envXml}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key>${s(log)}<key>StandardErrorPath</key>${s(log)}</dict></plist>\n`;
}

export function systemdUnit({ node, bin, env, args = ['run'] }) {
  const q = (v) => {
    const t = String(v);
    if (/[\x00-\x1f\x7f]/.test(t)) throw new Error(`service value has control characters: ${JSON.stringify(t)}`);
    return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  };
  const envLines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name: ${k}`);
    return `Environment=${q(`${k}=${v}`)}`;
  });
  return `[Unit]\nDescription=Argo (argo run)\nAfter=network-online.target\n\n[Service]\nExecStart=${q(node)} ${q(bin)} ${safeArgs(args).join(' ')}\n${envLines.join('\n')}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
}

/** 사용자 systemd bus 주소 — su·sudo로 바꾼 셸에는 XDG_RUNTIME_DIR이 없어 systemctl --user가 "Failed to connect to bus"로 실패한다.
    linger가 켜져 있으면 사용자 systemd가 /run/user/<uid>에 떠 있으니(dbus-user-session이 있으면 bus, 없어도 systemd/private — systemctl --user는 둘 다 쓴다),
    주소가 없을 때만 그 자리를 채운다(있는 값은 건드리지 않는다). */
export function userBusEnv(env, uid, exists) {
  if (env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS) return env;
  const dir = `/run/user/${uid}`;
  return exists(`${dir}/bus`) || exists(`${dir}/systemd/private`) ? { ...env, XDG_RUNTIME_DIR: dir } : env;
}

/** 리눅스 `argo service install` — linger를 먼저 확인하고(꺼져 있으면 권한이 있을 때만 켠다, 암호를 묻지 않고 sudo도 부르지 않는다),
    사용자 systemd에 유닛을 등록·(재)시작한다. 반환 { ok, linger } — ok=false는 user bus에 닿지 못해 등록하지 못함, linger=false면 호출자가 관리자 명령을 안내한다.
    헤드리스 서버(VPS 0.1.100 설치, 2026-10-10): linger가 꺼진 계정은 user bus가 없어 등록 자체가 실패했고, 안내는 끝에만 있었다.
    sh(cmd, args, { env, stdio }) → { status, stdout }, exists(path), sleep(ms)는 주입한다(시험). */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function installLinuxUserService({ user, uid, env = process.env, sh, exists, sleep = sleepSync }) {
  const lingerOn = () => /Linger=yes/.test(sh('loginctl', ['show-user', user, '--property=Linger']).stdout ?? '');
  let linger = lingerOn(); let turnedOn = false;
  if (!linger) { sh('loginctl', ['--no-ask-password', 'enable-linger', user]); linger = turnedOn = lingerOn(); }
  let busEnv = userBusEnv(env, uid, exists);
  let reload = sh('systemctl', ['--user', 'daemon-reload'], { env: busEnv });
  // 방금 linger를 켰으면 logind가 사용자 systemd를 띄우는 데 잠깐 걸린다 — 최대 5초 기다린다(그 밖에는 기다리지 않는다)
  for (let i = 0; reload.status !== 0 && turnedOn && i < 10; i++) {
    sleep(500);
    busEnv = userBusEnv(env, uid, exists);
    reload = sh('systemctl', ['--user', 'daemon-reload'], { env: busEnv });
  }
  if (reload.status !== 0) return { ok: false, linger };
  // enable --now는 이미 돌고 있는 상주를 다시 시작하지 않는다 — 역할을 바꿔 다시 등록해도(argo service install --standby) 옛 실행 인자로 계속 돌았다(D 1차 검수).
  // restart는 멈춰 있으면 시작하고 돌고 있으면 새 유닛으로 다시 시작한다.
  sh('systemctl', ['--user', 'enable', 'argo-cli.service'], { env: busEnv, stdio: 'inherit' });
  sh('systemctl', ['--user', 'restart', 'argo-cli.service'], { env: busEnv, stdio: 'inherit' });
  return { ok: true, linger };
}
