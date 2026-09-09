// 외부 에이전트 원클릭 연결(유건 지시 2026-09-08 "이렇게 어려우면 안 돼"): 메신저에서 [헤르메스 연결하기]를 누르면 앱이 **이 컴퓨터의**
// 헤르메스/오픈클로에 플러그인을 설치하고(번들 리소스 → ~/.hermes/plugins, ~/.openclaw/extensions), 봇 주소·토큰을 그쪽 .env에 써 넣고,
// 게이트웨이를 켠다. 사용자는 폴더 복사도 파일 편집도 터미널도 안 한다. CLI가 이 컴퓨터에 없으면 cli_missing으로 돌려 화면이 수동 안내를 보인다.
// 토큰은 에이전트의 .env(사용자 소유, 0600)에만 쓰고 로그·반환값에는 싣지 않는다.
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

const CMD_TIMEOUT: Duration = Duration::from_secs(90);

fn home() -> Result<PathBuf, String> {
    let vars = if cfg!(windows) { ["USERPROFILE", "HOME"] } else { ["HOME", "USERPROFILE"] };
    vars.into_iter().find_map(|v| std::env::var_os(v).filter(|v| !v.is_empty()).map(PathBuf::from)).ok_or_else(|| "Home directory unavailable".into())
}

fn cli_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&path)); }
    if let Ok(h) = home() {
        dirs.extend([h.join(".local/bin"), h.join(".npm-global/bin")]);
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA") { dirs.push(PathBuf::from(appdata).join("npm")); }
            if let Some(programfiles) = std::env::var_os("ProgramFiles") { dirs.push(PathBuf::from(programfiles).join("nodejs")); }
        } else { dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from)); }
    }
    dirs
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let suffixes: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    cli_dirs().into_iter().flat_map(|d| suffixes.iter().map(move |ext| d.join(format!("{name}{ext}")))).find(|p| p.is_file())
}

fn command(cli: &Path, args: &[&str]) -> Result<Command, String> {
    #[cfg(windows)]
    if cli.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        use std::os::windows::process::CommandExt;
        // npm's OpenClaw shim can be invoked through Node without cmd quoting/expansion.
        let entry = cli.parent().unwrap_or(Path::new(".")).join("node_modules/openclaw/openclaw.mjs");
        if cli.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("openclaw")) && entry.is_file() {
            let local_node = cli.parent().unwrap().join("node.exe");
            let node = if local_node.is_file() { local_node } else { find_cli("node").ok_or("Node executable unavailable")? };
            let mut cmd = Command::new(node); cmd.arg(entry).args(args); return Ok(cmd);
        }
        let path = cli.to_str().ok_or("Invalid CLI path")?;
        let line = batch_command_line(path, args)?;
        let mut cmd = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
        cmd.args(["/D", "/V:OFF", "/S", "/C"]).raw_arg(line);
        return Ok(cmd);
    }
    let mut cmd = Command::new(cli); cmd.args(args); Ok(cmd)
}

// cmd expands these characters even in quoted arguments. Reject rather than reinterpret data.
#[cfg(any(windows, test))]
fn batch_command_line(cli: &str, args: &[&str]) -> Result<String, String> {
    let words: Vec<&str> = std::iter::once(cli).chain(args.iter().copied()).collect();
    if words.iter().any(|v| v.chars().any(|c| "\"%!*?\r\n\0".contains(c))) { return Err("Unsafe batch argument; use a native executable".into()); }
    Ok(format!("\"{}\"", words.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(" ")))
}

fn redact(text: &str) -> String {
    let mut out = String::new(); let mut rest = text;
    while let Some(i) = rest.find("argo_bot_") {
        out.push_str(&rest[..i]); out.push_str("[redacted]");
        let value = &rest[i..]; let end = value.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(value.len());
        rest = &value[end..];
    }
    out.push_str(rest); out
}

fn run(cli: &Path, args: &[&str]) -> (bool, String) { run_env(cli, args, &[]) }
fn run_env(cli: &Path, args: &[&str], extra: &[(&str, String)]) -> (bool, String) {
    let mut cmd = match command(cli, args) { Ok(cmd) => cmd, Err(e) => return (false, e) };
    match std::env::join_paths(cli_dirs()) { Ok(path) => { cmd.env("PATH", path); }, Err(e) => return (false, e.to_string()) }
    for (k, v) in extra { cmd.env(k, v); }
    let mut child = match cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c, Err(e) => return (false, format!("spawn failed: {e}")),
    };
    // Drain both pipes while the command runs, including large config output.
    let stdout = child.stdout.take().unwrap(); let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn Read + Send>| { let mut bytes = Vec::new(); let _ = pipe.read_to_end(&mut bytes); String::from_utf8_lossy(&bytes).into_owned() };
    let out = std::thread::spawn(move || read(Box::new(stdout)));
    let err = std::thread::spawn(move || read(Box::new(stderr)));
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let stdout = out.join().unwrap_or_default(); let stderr = err.join().unwrap_or_default();
                return (st.success(), redact(&if st.success() { stdout } else { format!("{stdout}{stderr}") }));
            }
            Ok(None) if start.elapsed() > CMD_TIMEOUT => { let _ = child.kill(); let _ = child.wait(); return (false, "timeout".into()); }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return (false, e.to_string()); },
        }
    }
}

fn installation_id(dir: &Path) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("external-agent-installation-id");
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => { let mut bytes = [0u8; 16]; getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
            let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect(); f.write_all(id.as_bytes()).map_err(|e| e.to_string())?; Ok(id) },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let id = fs::read_to_string(path).map_err(|e| e.to_string())?;
            if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) { return Err("Invalid installation identity".into()); } Ok(id)
        },
        Err(e) => Err(e.to_string()),
    }
}

fn merge_binding(mut bindings: Vec<serde_json::Value>, id: &str) -> Vec<serde_json::Value> {
    bindings.retain(|b| !(b["match"]["channel"] == "argo-msgr" && b["match"]["accountId"] == id && b["match"].as_object().is_some_and(|m| m.len() == 2)));
    bindings.push(serde_json::json!({ "match": { "channel": "argo-msgr", "accountId": id }, "agentId": id })); bindings
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
    let cur = match fs::read_to_string(path) { Ok(text) => text, Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(), Err(e) => return Err(e.to_string()) };
    let next = upsert_env(&cur, pairs);
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(next.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600)); }
    Ok(())
}

fn step(name: &str, ok: bool, detail: impl Into<String>) -> serde_json::Value { serde_json::json!({ "name": name, "ok": ok, "detail": redact(&detail.into()).chars().take(2000).collect::<String>() }) }

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
pub fn agent_list(app: tauri::AppHandle, kind: String) -> Result<serde_json::Value, String> {
    if !(kind == "hermes" || kind == "openclaw") { return Err("kind".into()); }
    let cli_name = if kind == "hermes" { "hermes" } else { "openclaw" };
    let Some(cli) = find_cli(cli_name) else { return Ok(serde_json::json!({ "ok": false, "reason": "cli_missing", "agents": [] })); };
    let h = home()?;
    let agents: Vec<serde_json::Value> = if kind == "hermes" {
        let (ok, out) = run(&cli, &["profile", "list"]); if !ok { return Err(out); }
        parse_hermes_profiles(&out).into_iter().map(|(name, def)| {
            let path = hermes_profile_path(&cli, &name, &h);
            serde_json::json!({ "id": name, "name": if name == "default" { "Hermes".to_string() } else { name.clone() }, "default": def, "home": path.display().to_string() })
        }).collect()
    } else {
        let (ok, out) = run(&cli, &["agents", "list"]); if !ok { return Err(out); }
        parse_openclaw_agents(&out).into_iter().map(|(id, def)| serde_json::json!({ "id": id, "name": if id == "main" { "OpenClaw".to_string() } else { id.clone() }, "default": def })).collect()
    };
    Ok(serde_json::json!({ "ok": true, "cli": cli.display().to_string(), "agents": agents, "installationId": installation_id(&app.path().app_local_data_dir().map_err(|e| e.to_string())?)? }))
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
                steps.push(step("enable", e_ok, e_out)); if !e_ok { return false; }
                let (_, st) = run_env(&cli, &["gateway", "status"], &env);
                let (g_ok, g_out) = if st.contains("Gateway is running") { run_env(&cli, &["gateway", "restart"], &env) } else {
                    let (i_ok, i_out) = run_env(&cli, &["gateway", "install"], &env);
                    if i_ok { run_env(&cli, &["gateway", "start"], &env) } else { (false, i_out) }
                };
                steps.push(step("gateway", g_ok, g_out)); g_ok
            })();
            all_ok &= ok;
            results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
        }
    } else {
        let mut common = Vec::new();
        let plugin_ok = match copy_dir(&res_dir.join("agents/openclaw-argo-msgr"), &h.join(".openclaw/extensions/openclaw-argo-msgr")) { Ok(n) => { common.push(step("plugin", true, format!("{n} files"))); true }, Err(e) => { common.push(step("plugin", false, e)); false } };
        let plugin_ok = plugin_ok && { let (ok, out) = run(&cli, &["plugins", "enable", "openclaw-argo-msgr"]); common.push(step("enable", ok, out)); ok };
        for a in &agents {
            let mut steps = common.clone();
            let ok = plugin_ok && (|| -> bool {
                let base = format!("channels.argo-msgr.accounts[{}]", a.id);
                for (k, v) in [("url", url.as_str()), ("token", a.token.as_str()), ("enabled", "true")] {
                    let (ok, out) = run(&cli, &["config", "set", &format!("{base}.{k}"), v]);
                    if !ok { steps.push(step("env", false, out)); return false; }
                }
                steps.push(step("env", true, format!("openclaw.json {base}")));
                let (b_ok, b_out) = run(&cli, &["config", "get", "bindings", "--json"]);
                let bindings = if b_ok {
                    match serde_json::from_str::<Vec<serde_json::Value>>(&b_out) { Ok(v) => v, Err(_) => { steps.push(step("enable", false, "Invalid bindings config")); return false; } }
                } else if b_out.trim() == "Config path not found: bindings" { Vec::new() }
                else { steps.push(step("enable", false, b_out)); return false; };
                let json = serde_json::to_string(&merge_binding(bindings, &a.id)).unwrap();
                let (b_ok, b_out) = run(&cli, &["config", "set", "bindings", &json]);
                steps.push(step("enable", b_ok, b_out)); b_ok
            })();
            all_ok &= ok;
            results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
        }
        let (g_ok, g_out) = if all_ok { run(&cli, &["gateway", "restart"]) } else { (false, "Configuration failed; gateway unchanged".into()) };
        let (g_ok, g_out) = if g_ok || !all_ok { (g_ok, g_out) } else { let (i_ok, i_out) = run(&cli, &["gateway", "install"]); if i_ok { run(&cli, &["gateway", "start"]) } else { (false, format!("{g_out}\n{i_out}")) } };
        all_ok &= g_ok;
        for r in results.iter_mut() { if !g_ok { r["ok"] = false.into(); } if let Some(arr) = r.get_mut("steps").and_then(|s| s.as_array_mut()) { arr.push(step("gateway", g_ok, g_out.clone())); } }
    }
    Ok(serde_json::json!({ "ok": all_ok, "reason": if all_ok { "" } else { "gateway" }, "cli": cli.display().to_string(), "results": results }))
}

#[cfg(test)]
mod tests {
    use super::{upsert_env, parse_hermes_profiles, parse_openclaw_agents, merge_binding, batch_command_line, installation_id, redact};
    #[test]
    fn binding_upsert_keeps_telegram_other_agents_and_peer_routes() {
        let telegram = serde_json::json!({"match":{"channel":"telegram","accountId":"default"},"agentId":"support"});
        let peer = serde_json::json!({"match":{"channel":"argo-msgr","accountId":"main","peer":{"id":"person"}},"agentId":"special"});
        let first = merge_binding(vec![telegram.clone(), peer.clone()], "main");
        let second = merge_binding(first, "support");
        let third = merge_binding(second.clone(), "main");
        assert_eq!(third.len(), 4); assert!(third.contains(&telegram)); assert!(third.contains(&peer));
        assert_eq!(third.iter().filter(|b| b["agentId"] == "support").count(), 2);
        assert_eq!(merge_binding(third.clone(), "main"), third);
    }
    #[test]
    fn batch_paths_with_spaces_are_quoted_and_expansion_rejected() {
        assert_eq!(batch_command_line(r"C:\Users\Some User\hermes.cmd", &["profile", "show", "default"]).unwrap(), r#"""C:\Users\Some User\hermes.cmd" "profile" "show" "default"""#);
        for value in ["%PATH%", "a!b", "a\"b", "a\nb"] { assert!(batch_command_line("tool.cmd", &[value]).is_err()); }
    }
    #[test]
    fn installation_identity_persists_and_other_installations_differ() {
        let dir = std::env::temp_dir().join(format!("argo-install-test-{}", std::process::id()));
        let a = dir.join("a"); let b = dir.join("b");
        let first = installation_id(&a).unwrap();
        assert_eq!(first, installation_id(&a).unwrap()); assert_ne!(first, installation_id(&b).unwrap());
        std::fs::write(a.join("external-agent-installation-id"), "broken").unwrap();
        assert!(installation_id(&a).is_err()); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn credential_output_is_redacted() {
        assert_eq!(redact("error argo_bot_example, again argo_bot_other"), "error [redacted], again [redacted]");
    }
    #[cfg(windows)]
    #[test]
    fn windows_batch_shim_executes_from_path_with_spaces() {
        let dir = std::env::temp_dir().join(format!("argo batch test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap(); let cli = dir.join("hermes.cmd");
        std::fs::write(&cli, "@echo off\r\necho %~1\r\n").unwrap();
        let (ok, output) = super::run(&cli, &["hello world"]);
        std::fs::remove_dir_all(dir).unwrap(); assert!(ok, "{output}"); assert_eq!(output.trim(), "hello world");
    }
    #[cfg(windows)]
    #[test]
    fn windows_openclaw_npm_shim_passes_json_literally() {
        let dir = std::env::temp_dir().join(format!("argo npm test {}", std::process::id()));
        let package = dir.join("node_modules/openclaw"); std::fs::create_dir_all(&package).unwrap();
        let cli = dir.join("openclaw.cmd"); std::fs::write(&cli, "@exit /b 1\r\n").unwrap();
        std::fs::write(package.join("openclaw.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))").unwrap();
        let json = r#"[{"match":{"channel":"argo-msgr","accountId":"a.b"},"agentId":"a.b"}]"#;
        let (ok, output) = super::run(&cli, &["config", "set", "bindings", json]);
        std::fs::remove_dir_all(dir).unwrap(); assert!(ok, "{output}");
        assert_eq!(serde_json::from_str::<Vec<String>>(&output).unwrap(), ["config", "set", "bindings", json]);
    }
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
