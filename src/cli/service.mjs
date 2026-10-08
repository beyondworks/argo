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
