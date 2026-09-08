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
fn run(cli: &Path, args: &[&str]) -> (bool, String) { run_env(cli, args, &[]) }
fn run_env(cli: &Path, args: &[&str], extra: &[(&str, String)]) -> (bool, String) {
    let mut cmd = Command::new(cli); cmd.args(args).env("PATH", spawn_path()); for (k, v) in extra { cmd.env(k, v); }
    let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
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

/// `hermes profile list` 표에서 프로필 이름을 뽑는다(◆ = 기본 프로필). 표 머리·구분선은 건너뛴다.
pub fn parse_hermes_profiles(out: &str) -> Vec<(String, bool)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("Profile") || t.starts_with('─') || t.starts_with('-') { continue; }
        let (is_default, rest) = if let Some(r) = t.strip_prefix('◆') { (true, r.trim()) } else { (false, t) };
        let name = rest.split_whitespace().next().unwrap_or("").trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.');
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') { v.push((name.to_string(), is_default)); }
    }
    v
}

/// `openclaw agents list` 출력의 "- <id> (default)" 줄에서 에이전트 id를 뽑는다.
pub fn parse_openclaw_agents(out: &str) -> Vec<(String, bool)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("- ") else { continue };
        let is_default = rest.contains("(default)");
        let id = rest.split_whitespace().next().unwrap_or("").to_string();
        if !id.is_empty() && id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') { v.push((id, is_default)); }
    }
    v
}

fn hermes_profile_path(cli: &Path, name: &str, h: &Path) -> PathBuf {
    let (_, out) = run(cli, &["profile", "show", name]);
    out.lines().find_map(|l| l.trim().strip_prefix("Path:").map(|p| PathBuf::from(p.trim()))).unwrap_or_else(|| if name == "default" { h.join(".hermes") } else { h.join(".hermes/profiles").join(name) })
}

/// 이 컴퓨터에 있는 에이전트 전원 — 헤르메스는 프로필(각각 격리된 인스턴스), 오픈클로는 등록된 에이전트. 앱은 이 목록으로 봇을 하나씩 만든다.
#[tauri::command]
pub fn agent_list(kind: String) -> Result<serde_json::Value, String> {
    if !(kind == "hermes" || kind == "openclaw") { return Err("kind".into()); }
    let cli_name = if kind == "hermes" { "hermes" } else { "openclaw" };
    let Some(cli) = find_cli(cli_name) else { return Ok(serde_json::json!({ "ok": false, "reason": "cli_missing", "agents": [] })); };
    let h = home()?;
    let agents: Vec<serde_json::Value> = if kind == "hermes" {
        let (_, out) = run(&cli, &["profile", "list"]);
        parse_hermes_profiles(&out).into_iter().map(|(name, def)| {
            let path = hermes_profile_path(&cli, &name, &h);
            serde_json::json!({ "id": name, "name": if name == "default" { "Hermes".to_string() } else { name.clone() }, "default": def, "home": path.display().to_string() })
        }).collect()
    } else {
        let (_, out) = run(&cli, &["agents", "list"]);
        parse_openclaw_agents(&out).into_iter().map(|(id, def)| serde_json::json!({ "id": id, "name": if id == "main" { "OpenClaw".to_string() } else { id.clone() }, "default": def })).collect()
    };
    Ok(serde_json::json!({ "ok": true, "cli": cli.display().to_string(), "agents": agents }))
}

#[derive(serde::Deserialize)]
pub struct AgentSetup { pub id: String, pub token: String, #[serde(default)] pub home: String }

/// 에이전트 전원 연결: 헤르메스는 프로필 홈(HERMES_HOME)마다 플러그인·.env·게이트웨이, 오픈클로는 플러그인 한 번 + 에이전트별 채널 계정·바인딩 + 게이트웨이 재시작.
#[tauri::command]
pub fn agent_connect(app: tauri::AppHandle, kind: String, url: String, agents: Vec<AgentSetup>) -> Result<serde_json::Value, String> {
    if !(kind == "hermes" || kind == "openclaw") { return Err("kind".into()); }
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 400 { return Err("url".into()); }
    if agents.is_empty() { return Err("agents".into()); }
    for a in &agents {
        if !(a.token.starts_with("argo_bot_") && a.token.len() == 57 && a.token[9..].chars().all(|c| c.is_ascii_hexdigit())) { return Err("token".into()); }
        if a.id.is_empty() || !a.id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') { return Err("agent id".into()); }
    }
    let cli_name = if kind == "hermes" { "hermes" } else { "openclaw" };
    let Some(cli) = find_cli(cli_name) else { return Ok(serde_json::json!({ "ok": false, "reason": "cli_missing", "cli": cli_name, "results": [] })); };
    let h = home()?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    let mut all_ok = true;
    if kind == "hermes" {
        for a in &agents {
            let hh = if a.home.is_empty() { h.join(".hermes") } else { PathBuf::from(&a.home) };
            let mut steps = Vec::new();
            let ok = (|| -> bool {
                match copy_dir(&res_dir.join("agents/hermes-argo-msgr"), &hh.join("plugins/argo-msgr")) { Ok(n) => steps.push(step("plugin", true, format!("{n} files"))), Err(e) => { steps.push(step("plugin", false, e)); return false; } }
                match write_env(&hh.join(".env"), &[("ARGO_MSGR_URL", url.as_str()), ("ARGO_MSGR_BOT_TOKEN", a.token.as_str())]) { Ok(()) => steps.push(step("env", true, hh.join(".env").display().to_string())), Err(e) => { steps.push(step("env", false, e)); return false; } }
                let env = [("HERMES_HOME", hh.display().to_string())];
                let (e_ok, e_out) = run_env(&cli, &["plugins", "enable", "argo-msgr-platform", "--no-allow-tool-override"], &env);
                steps.push(step("enable", e_ok || e_out.contains("already"), e_out));
                let (_, st) = run_env(&cli, &["gateway", "status"], &env);
                let (g_ok, g_out) = if st.contains("Gateway is running") { run_env(&cli, &["gateway", "restart"], &env) } else {
                    let (i_ok, i_out) = run_env(&cli, &["gateway", "install"], &env);
                    if i_ok || i_out.contains("already") { run_env(&cli, &["gateway", "start"], &env) } else { (false, i_out) }
                };
                steps.push(step("gateway", g_ok, g_out)); g_ok
            })();
            all_ok &= ok;
            results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
        }
    } else {
        let mut common = Vec::new();
        let plugin_ok = match copy_dir(&res_dir.join("agents/openclaw-argo-msgr"), &h.join(".openclaw/extensions/openclaw-argo-msgr")) { Ok(n) => { common.push(step("plugin", true, format!("{n} files"))); true }, Err(e) => { common.push(step("plugin", false, e)); false } };
        for a in &agents {
            let mut steps = common.clone();
            let ok = plugin_ok && (|| -> bool {
                let base = format!("channels.argo-msgr.accounts.{}", a.id);
                for (k, v) in [("url", url.as_str()), ("token", a.token.as_str()), ("enabled", "true")] {
                    let (ok, out) = run(&cli, &["config", "set", &format!("{base}.{k}"), v]);
                    if !ok { steps.push(step("env", false, out)); return false; }
                }
                steps.push(step("env", true, format!("openclaw.json {base}")));
                // 라우팅: 이 채널 계정 → 이 에이전트(기본 에이전트는 바인딩 없이도 기본 라우팅)
                let (b_ok, b_out) = run(&cli, &["config", "set", "bindings", &format!("[{{ match: {{ channel: \"argo-msgr\", accountId: \"{}\" }}, agentId: \"{}\" }}]", a.id, a.id)]);
                steps.push(step("enable", b_ok, b_out)); true
            })();
            all_ok &= ok;
            results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
        }
        let (g_ok, g_out) = run(&cli, &["gateway", "restart"]);
        let (g_ok, g_out) = if g_ok { (g_ok, g_out) } else { let (i_ok, i_out) = run(&cli, &["gateway", "install"]); if i_ok { run(&cli, &["gateway", "start"]) } else { (false, format!("{g_out}\n{i_out}")) } };
        all_ok &= g_ok;
        for r in results.iter_mut() { if let Some(arr) = r.get_mut("steps").and_then(|s| s.as_array_mut()) { arr.push(step("gateway", g_ok, g_out.clone())); } }
    }
    Ok(serde_json::json!({ "ok": all_ok, "reason": if all_ok { "" } else { "gateway" }, "cli": cli.display().to_string(), "results": results }))
}

#[cfg(test)]
mod tests {
    use super::{upsert_env, parse_hermes_profiles, parse_openclaw_agents};
    #[test]
    fn parses_agent_lists() {
        let h = " Profile          Model      Gateway\n ───────  ────  ────\n ◆default         claude-opus-5   running\n  research        gpt-6-astra   stopped\n";
        assert_eq!(parse_hermes_profiles(h), vec![("default".to_string(), true), ("research".to_string(), false)]);
        let o = "Agents:\n- main (default)\n  Workspace: ~/.openclaw/workspace\n- support\n  Workspace: x\nRouting rules map…\n";
        assert_eq!(parse_openclaw_agents(o), vec![("main".to_string(), true), ("support".to_string(), false)]);
    }
    #[test]
    fn upsert_replaces_only_matching_keys() {
        let cur = "OTHER=1\nARGO_MSGR_URL=old\n# note\n";
        let next = upsert_env(cur, &[("ARGO_MSGR_URL", "https://x/functions/v1/msgr-bot"), ("ARGO_MSGR_BOT_TOKEN", "argo_bot_x")]);
        assert_eq!(next, "OTHER=1\nARGO_MSGR_URL=https://x/functions/v1/msgr-bot\n# note\nARGO_MSGR_BOT_TOKEN=argo_bot_x\n");
        assert_eq!(upsert_env("", &[("A", "1")]), "A=1\n");
    }
}
