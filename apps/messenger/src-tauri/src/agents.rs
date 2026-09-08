// 외부 에이전트 원클릭 연결(유건 지시 2026-09-08 "이렇게 어려우면 안 돼"): 메신저에서 [헤르메스 연결하기]를 누르면 앱이 **이 컴퓨터의**
// 헤르메스/오픈클로에 플러그인을 설치하고(번들 리소스 → ~/.hermes/plugins, ~/.openclaw/extensions), 봇 주소·토큰을 그쪽 .env에 써 넣고,
// 게이트웨이를 켠다. 사용자는 폴더 복사도 파일 편집도 터미널도 안 한다. CLI가 이 컴퓨터에 없으면 cli_missing으로 돌려 화면이 수동 안내를 보인다.
// 토큰은 에이전트의 .env(사용자 소유, 0600)에만 쓰고 로그·반환값에는 싣지 않는다.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

const CMD_TIMEOUT: Duration = Duration::from_secs(90);

fn home() -> Result<PathBuf, String> { std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME 없음".into()) }

/// PATH + 흔한 설치 위치에서 CLI 실행 파일을 찾는다(웹뷰에서 뜬 앱은 로그인 셸 PATH를 못 받는다).
fn find_cli(name: &str) -> Option<PathBuf> {
    let h = home().ok()?;
    let mut cands: Vec<PathBuf> = vec![h.join(".local/bin").join(name), PathBuf::from("/opt/homebrew/bin").join(name), PathBuf::from("/usr/local/bin").join(name), h.join(".npm-global/bin").join(name)];
    if let Some(p) = std::env::var_os("PATH") { for d in std::env::split_paths(&p) { cands.push(d.join(name)); } }
    cands.into_iter().find(|p| p.is_file())
}

fn spawn_path() -> String {
    let h = home().map(|h| h.display().to_string()).unwrap_or_default();
    let mut parts = vec![format!("{h}/.local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into(), "/bin".into(), format!("{h}/.npm-global/bin")];
    if let Ok(p) = std::env::var("PATH") { parts.push(p); }
    parts.join(":")
}

/// 명령 실행(상한 90초). 출력은 앞 2000자만 돌려준다.
fn run(cli: &Path, args: &[&str]) -> (bool, String) {
    let mut child = match Command::new(cli).args(args).env("PATH", spawn_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return (false, format!("spawn failed: {e}")),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let out = child.wait_with_output().map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))).unwrap_or_default();
                return (st.success(), out.chars().take(2000).collect());
            }
            Ok(None) if start.elapsed() > CMD_TIMEOUT => { let _ = child.kill(); return (false, "timeout".into()); }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return (false, e.to_string()),
        }
    }
}

fn copy_dir(src: &Path, dst: &Path) -> Result<usize, String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let mut n = 0;
    for ent in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let ent = ent.map_err(|e| e.to_string())?; let p = ent.path(); let name = ent.file_name();
        let s = name.to_string_lossy();
        if s == "node_modules" || s.starts_with('.') || s == "__pycache__" { continue; }
        if p.is_dir() { n += copy_dir(&p, &dst.join(&name))?; } else { fs::copy(&p, dst.join(&name)).map_err(|e| format!("copy {}: {e}", p.display()))?; n += 1; }
    }
    Ok(n)
}

/// .env에 KEY=값을 넣는다 — 이미 있으면 그 줄만 바꾸고 나머지는 그대로. 새 파일은 0600.
pub fn upsert_env(text: &str, pairs: &[(&str, &str)]) -> String {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    for (k, v) in pairs {
        let line = format!("{k}={v}");
        if let Some(i) = lines.iter().position(|l| l.trim_start().starts_with(&format!("{k}="))) { lines[i] = line; } else { lines.push(line); }
    }
    let mut out = lines.join("\n"); if !out.ends_with('\n') { out.push('\n'); } out
}

fn write_env(path: &Path, pairs: &[(&str, &str)]) -> Result<(), String> {
    if let Some(d) = path.parent() { fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let cur = fs::read_to_string(path).unwrap_or_default();
    let next = upsert_env(&cur, pairs);
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(next.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600)); }
    Ok(())
}

fn step(name: &str, ok: bool, detail: impl Into<String>) -> serde_json::Value { serde_json::json!({ "name": name, "ok": ok, "detail": detail.into() }) }

#[tauri::command]
pub fn agent_connect(app: tauri::AppHandle, kind: String, url: String, token: String) -> Result<serde_json::Value, String> {
    if !(kind == "hermes" || kind == "openclaw") { return Err("kind".into()); }
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 400 { return Err("url".into()); }
    if !(token.starts_with("argo_bot_") && token.len() == 57 && token[9..].chars().all(|c| c.is_ascii_hexdigit())) { return Err("token".into()); }
    let cli_name = if kind == "hermes" { "hermes" } else { "openclaw" };
    let Some(cli) = find_cli(cli_name) else { return Ok(serde_json::json!({ "ok": false, "reason": "cli_missing", "cli": cli_name, "steps": [] })); };
    let h = home()?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let mut steps = Vec::new();
    let (src, dst, env_path) = if kind == "hermes" {
        (res_dir.join("agents/hermes-argo-msgr"), h.join(".hermes/plugins/argo-msgr"), h.join(".hermes/.env"))
    } else {
        (res_dir.join("agents/openclaw-argo-msgr"), h.join(".openclaw/extensions/openclaw-argo-msgr"), h.join(".openclaw/.env"))
    };
    // 1) 플러그인 파일
    match copy_dir(&src, &dst) { Ok(n) => steps.push(step("plugin", true, format!("{} files → {}", n, dst.display()))), Err(e) => { steps.push(step("plugin", false, e)); return Ok(serde_json::json!({ "ok": false, "reason": "plugin", "cli": cli_name, "steps": steps })); } }
    // 2) 설정(.env) — 토큰은 여기에만
    match write_env(&env_path, &[("ARGO_MSGR_URL", url.as_str()), ("ARGO_MSGR_BOT_TOKEN", token.as_str())]) { Ok(()) => steps.push(step("env", true, env_path.display().to_string())), Err(e) => { steps.push(step("env", false, e)); return Ok(serde_json::json!({ "ok": false, "reason": "env", "cli": cli_name, "steps": steps })); } }
    // 3) 활성화 + 게이트웨이
    let mut ok = true;
    if kind == "hermes" {
        let (e_ok, e_out) = run(&cli, &["plugins", "enable", "argo-msgr-platform", "--no-allow-tool-override"]);
        steps.push(step("enable", e_ok || e_out.contains("already"), e_out));
        let (_, st) = run(&cli, &["gateway", "status"]);
        let running = st.contains("Gateway is running");
        let (g_ok, g_out) = if running { run(&cli, &["gateway", "restart"]) } else {
            let (i_ok, i_out) = run(&cli, &["gateway", "install"]);
            if i_ok || i_out.contains("already") { run(&cli, &["gateway", "start"]) } else { (false, i_out) }
        };
        ok = g_ok; steps.push(step("gateway", g_ok, g_out));
    } else {
        let (g_ok, g_out) = run(&cli, &["gateway", "restart"]);
        let (g_ok, g_out) = if g_ok { (g_ok, g_out) } else { let (i_ok, i_out) = run(&cli, &["gateway", "install"]); if i_ok { run(&cli, &["gateway", "start"]) } else { (false, format!("{g_out}\n{i_out}")) } };
        ok = g_ok; steps.push(step("gateway", g_ok, g_out));
    }
    Ok(serde_json::json!({ "ok": ok, "reason": if ok { "" } else { "gateway" }, "cli": cli.display().to_string(), "steps": steps }))
}

#[cfg(test)]
mod tests {
    use super::upsert_env;
    #[test]
    fn upsert_replaces_only_matching_keys() {
        let cur = "OTHER=1\nARGO_MSGR_URL=old\n# note\n";
        let next = upsert_env(cur, &[("ARGO_MSGR_URL", "https://x/functions/v1/msgr-bot"), ("ARGO_MSGR_BOT_TOKEN", "argo_bot_x")]);
        assert_eq!(next, "OTHER=1\nARGO_MSGR_URL=https://x/functions/v1/msgr-bot\n# note\nARGO_MSGR_BOT_TOKEN=argo_bot_x\n");
        assert_eq!(upsert_env("", &[("A", "1")]), "A=1\n");
    }
}
