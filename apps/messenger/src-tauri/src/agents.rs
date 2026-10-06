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
    run_env_with_home(cli, args, extra, home().ok().as_deref())
}
fn run_env_with_home(cli: &Path, args: &[&str], extra: &[(&str, String)], dock_home: Option<&Path>) -> (bool, String) {
    let mut cmd = match command(cli, args) { Ok(cmd) => cmd, Err(e) => return (false, e) };
    match std::env::join_paths(cli_dirs()) { Ok(path) => { cmd.env("PATH", path); }, Err(e) => return (false, e.to_string()) }
    for (k, v) in extra { cmd.env(k, v); }
    #[cfg(target_os = "macos")]
    {
        let inherited = std::env::var("NODE_OPTIONS").ok();
        let previous = extra.iter().rev().find(|(k, _)| *k == "NODE_OPTIONS").map(|(_, v)| v.as_str()).or(inherited.as_deref());
        let prepared = (|| {
            let options = crate::no_dock::prepare(dock_home.ok_or("Home unavailable")?, previous)?;
            let node = find_cli("node").ok_or("Node executable unavailable")?;
            crate::no_dock::validate(&node, &options, Duration::from_secs(10))?;
            Ok::<_, String>(options)
        })();
        match prepared {
            Ok(options) => { cmd.env("NODE_OPTIONS", options); }
            Err(_) => eprintln!("[argo-messenger] Dock suppression unavailable; preserving CLI environment"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dock_home;
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

/// `openclaw agents list` 텍스트의 에이전트 줄("- <id> (default)", 들여쓰기 없음). 들여쓴 "- " 줄은 채널·공급자 항목이다
/// (예: "    - Argo Messenger main: configured") — 에이전트로 읽지 않는다. `--json`이 없는 CLI에서만 쓰는 대체 경로.
pub fn parse_openclaw_agents(out: &str) -> Vec<(String, bool)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("- ") else { continue };
        let rest = rest.trim();
        let is_default = rest.contains("(default)");
        let id = rest.split_whitespace().next().unwrap_or("").to_string();
        if !id.is_empty() && id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') { v.push((id, is_default)); }
    }
    v
}

// 2026.8.1에서 루트 `openclaw/plugin-sdk`가 없어졌다 — 그보다 낮은 버전에는 앱이 싣는 새 플러그인이 올라가지 않는다(connect.py OPENCLAW_MIN과 같은 값).
const OPENCLAW_MIN: (u32, u32, u32) = (2026, 8, 1);
const OPENCLAW_PLUGIN_ID: &str = "openclaw-argo-msgr";

/// CLI 출력에서 JSON 본문만 읽는다 — 앞에 경고 줄이 섞여 나와도 된다. 없거나 깨졌으면 None.
fn json_part(out: &str) -> Option<serde_json::Value> {
    let mut offset = 0;
    for line in out.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with('{') || t.starts_with('[') { return serde_json::from_str(&out[offset..]).ok(); }
        offset += line.len();
    }
    None
}

/// `openclaw agents list --json` → [(id, 기본 여부)]. 형식이 다르면 None(텍스트 목록으로 대체).
fn parse_openclaw_agents_json(out: &str) -> Option<Vec<(String, bool)>> {
    let data = json_part(out)?;
    Some(data.as_array()?.iter().filter_map(|a| {
        let id = a.get("id")?.as_str()?;
        (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')).then(|| (id.to_string(), a.get("isDefault") == Some(&serde_json::Value::Bool(true))))
    }).collect())
}

/// `openclaw --version`("OpenClaw 2026.9.6 (eb377ac)") → ((2026, 9, 6), 베타 여부). 못 읽으면 None.
fn parse_openclaw_version(out: &str) -> Option<((u32, u32, u32), bool)> {
    let b = out.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let digits = |i: usize| b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    for i in 0..b.len() {
        if !b[i].is_ascii_digit() || (i > 0 && word(b[i - 1])) || digits(i) != 4 { continue; }
        let j = i + 5; if b.get(i + 4) != Some(&b'.') { continue; }
        let n2 = digits(j); if !(1..=2).contains(&n2) || b.get(j + n2) != Some(&b'.') { continue; }
        let k = j + n2 + 1; let n3 = digits(k); if !(1..=3).contains(&n3) { continue; }
        let end = k + n3;
        let suffix = if b.get(end) == Some(&b'-') { let n = b[end + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.').count(); &out[end + 1..end + 1 + n] } else { "" };
        if suffix.is_empty() && b.get(end).is_some_and(|c| word(*c)) { continue; }
        let num = |s: &str| s.parse::<u32>().ok();
        return Some(((num(&out[i..i + 4])?, num(&out[j..j + n2])?, num(&out[k..end])?), suffix.contains("beta")));
    }
    None
}

/// 오픈클로가 새 플러그인을 올릴 수 있는 버전인지(`openclaw --version`의 결과). 괜찮으면 None, 아니면 Some(감지한 버전 — 읽지 못했으면 빈 문자열).
/// 사용자 문구는 화면이 reason "openclaw_outdated"를 사전(i18n.js org.agents.openclaw.outdated)으로 번역한다 — 여기서는 문장을 만들지 않는다.
fn openclaw_version_problem(ok: bool, out: &str) -> Option<String> {
    let Some((ver, beta)) = parse_openclaw_version(out).filter(|_| ok) else { return Some(String::new()); };
    if ver > OPENCLAW_MIN || (ver == OPENCLAW_MIN && !beta) { return None; }
    Some(format!("{}.{}.{}{}", ver.0, ver.1, ver.2, if beta { "-beta" } else { "" }))
}

/// `openclaw config get bindings --json` → 바인딩 목록. 아직 없으면 빈 목록, 읽을 수 없으면 None.
/// 없을 때 예전 CLI는 "Config path not found: bindings", 2026.8.x+는 rc=1과 {"ok":false,"error":{"message":"Config path is valid but unset: bindings…"}}.
fn openclaw_bindings(ok: bool, out: &str) -> Option<Vec<serde_json::Value>> {
    if !ok {
        let unset = ["Config path not found: bindings", "Config path is valid but unset: bindings"].iter().any(|m| out.match_indices(m).any(|(i, _)| !out[i + m.len()..].chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_')));
        return unset.then(Vec::new);
    }
    match json_part(out) {
        Some(serde_json::Value::Array(v)) => Some(v),
        None if matches!(out.trim(), "" | "null") => Some(Vec::new()),
        _ => None,
    }
}

/// `plugins inspect <id> --runtime --json`의 plugin.status로 실제 로드를 판정한다. `plugins enable`은 로드에 실패해도 rc=0이고
/// `plugins list --json`도 깨진 플러그인을 loaded로 보여 판정에 못 쓴다(실측). 정상이면 None, 아니면 오류 내용(끝 300자).
fn openclaw_plugin_load_error(ok: bool, out: &str) -> Option<String> {
    let tail = |s: &str| { let n = s.chars().count(); s.chars().skip(n.saturating_sub(300)).collect::<String>() };
    let data = if ok { json_part(out) } else { None };
    let Some(plugin) = data.as_ref().and_then(|d| d.get("plugin")).filter(|p| p.is_object()) else {
        return Some(tail(if out.trim().is_empty() { "plugins inspect failed" } else { out.trim() }));
    };
    let error = plugin.get("error").filter(|e| !e.is_null() && *e != "" && *e != false);
    if plugin.get("status").and_then(|s| s.as_str()) == Some("loaded") && error.is_none() { return None; }
    let diags: Vec<&str> = data.as_ref().and_then(|d| d.get("diagnostics")).and_then(|d| d.as_array()).map(|d| d.iter().filter(|x| x.get("level").and_then(|l| l.as_str()) == Some("error")).filter_map(|x| x.get("message").and_then(|m| m.as_str())).collect()).unwrap_or_default();
    let status = plugin.get("status").map(|s| s.as_str().map(str::to_string).unwrap_or_else(|| s.to_string())).unwrap_or_else(|| "None".into());
    Some(tail(&match error { Some(e) => e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()), None if !diags.is_empty() => diags.join("; "), None => format!("status={status}") }))
}

/// 오픈클로 목록 실패 — 버전이 모자람(감지한 버전) 또는 CLI 오류 원문.
#[derive(Debug, PartialEq)]
enum OpenclawListError { Outdated(String), Cli(String) }

/// 에이전트 목록: 버전이 모자라면 목록을 읽지 않는다. `--json`을 먼저 쓰고, 그 옵션이 없는 CLI만 텍스트로 읽는다.
fn openclaw_agents(mut run: impl FnMut(&[&str]) -> (bool, String)) -> Result<Vec<(String, bool)>, OpenclawListError> {
    let (ok, out) = run(&["--version"]);
    if let Some(have) = openclaw_version_problem(ok, &out) { return Err(OpenclawListError::Outdated(have)); }
    let (ok, out) = run(&["agents", "list", "--json"]);
    if let Some(found) = parse_openclaw_agents_json(&out).filter(|_| ok) { return Ok(found); }
    let (ok, out) = run(&["agents", "list"]); if !ok { return Err(OpenclawListError::Cli(out)); }
    Ok(parse_openclaw_agents(&out))
}

/// 플러그인 켜기: 게이트웨이가 돌고 있으면 `plugins enable`은 게이트웨이에 요청하는데, 게이트웨이는 저장된 플러그인 목록만 알아서 방금 복사한
/// 폴더를 "plugin not installed"로 거절한다(2026.9.6 실측) — 목록을 먼저 다시 만든다. 켠 뒤에는 실제로 불러와 보고, 안 되면 계정·바인딩을 쓰기 전에 멈춘다.
fn openclaw_enable_plugin(run: &mut impl FnMut(&[&str]) -> (bool, String), steps: &mut Vec<serde_json::Value>) -> bool {
    let (ok, out) = run(&["plugins", "registry", "--refresh"]);
    if !ok { steps.push(step("enable", false, out)); return false; }
    let (ok, out) = run(&["plugins", "enable", OPENCLAW_PLUGIN_ID]);
    if !ok { steps.push(step("enable", false, out)); return false; }
    let (i_ok, i_out) = run(&["plugins", "inspect", OPENCLAW_PLUGIN_ID, "--runtime", "--json"]);
    if let Some(err) = openclaw_plugin_load_error(i_ok, &i_out) {
        steps.push(step("enable", false, err)); // CLI 진단 원문(다른 단계 실패와 같은 방식) — 안내 문장은 화면의 사전이 붙인다
        return false;
    }
    steps.push(step("enable", true, out)); true
}

/// 원본 YAML에 top.sub가 명시돼 있는가(기본값과 구분) — server-connect/connect.py `yaml_sets`와 같은 규칙.
/// 블록(`top:` 바로 아래 한 단계 들여쓴 `sub:`)과 한 줄(`top: {sub: …}`)만 본다. 다른 최상위 키·더 깊은 같은 이름은 아니다.
fn yaml_sets(text: &str, top: &str, sub: &str) -> bool {
    let key_at = |s: &str| s.strip_prefix(sub).is_some_and(|r| r.trim_start().starts_with(':'));
    // 파이썬 splitlines처럼 CR만·NEL 줄끝도 나눈다(CRLF 사이에 생기는 빈 줄은 아래에서 건너뛴다). BOM은 YAML이 무시한다.
    let lines: Vec<&str> = text.trim_start_matches('\u{feff}').split(['\n', '\r', '\u{85}']).collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(rest) = line.strip_prefix(top).map(str::trim_start).and_then(|r| r.strip_prefix(':')).map(str::trim_start) else { continue };
        if let Some(inner) = rest.strip_prefix('{') {
            let inner = inner.split('}').next().unwrap_or("");
            if inner.match_indices(sub).any(|(j, _)| !inner[..j].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') && key_at(&inner[j..])) { return true; }
            continue;
        }
        if !(rest.is_empty() || rest.starts_with('#')) { continue; }
        let mut indent = None; // 바로 아래 한 단계만(approvals.gateway.mode 같은 더 깊은 mode는 아니다)
        for nxt in &lines[i + 1..] {
            let body = nxt.trim_start();
            if body.is_empty() || body.starts_with('#') { continue; }
            if !nxt.starts_with(char::is_whitespace) { break; }
            let lead = nxt.len() - body.len();
            if lead == *indent.get_or_insert(lead) && key_at(body) { return true; }
        }
    }
    false
}

/// 1-b(2026-09-29 유건 결정, connect.py와 같은 규칙): 연결할 때 위험 명령은 사람에게 묻는 manual이 기본값. 이미 명시한 값(smart 등)은 덮어쓰지 않는다 —
/// 그때는 메신저 에이전트 카드가 실제 모드를 보여 준다. Hermes 기본값 smart는 보조 AI가 괜찮다고 보면 결재 카드 없이 실행한다.
fn hermes_default_manual(home: &Path, mut run: impl FnMut(&[&str]) -> (bool, String)) -> &'static str {
    let text = fs::read_to_string(home.join("config.yaml")).unwrap_or_default();
    if yaml_sets(&text, "approvals", "mode") { return "kept"; }
    if run(&["config", "set", "approvals.mode", "manual"]).0 { "manual" } else { "failed" }
}

/// OpenClaw 기본값 full은 사람 승인 없이 모든 명령을 실행한다(결재 카드가 한 번도 뜨지 않는다). 명시한 값이 없을 때만 ask로(connect.py와 같은 규칙).
fn openclaw_default_ask(run: &mut impl FnMut(&[&str]) -> (bool, String)) -> &'static str {
    let (ok, out) = run(&["config", "get", "tools.exec.mode"]);
    // 값이 없다고 확신할 때만 쓴다 — 시간 초과·권한 오류를 "없음"으로 읽으면 사용자가 적은 값을 덮는다(openclaw_bindings와 같은 문구 판정).
    if !ok && !["Config path not found", "Config path is valid but unset"].iter().any(|m| out.contains(m)) { return "failed"; }
    let val = if ok { out.trim().trim_matches('"').to_ascii_lowercase() } else { String::new() };
    if !val.is_empty() && !["undefined", "null", "none"].contains(&val.as_str()) { return "kept"; }
    if run(&["config", "set", "tools.exec.mode", "ask"]).0 { "ask" } else { "failed" }
}

/// 승인 모드 단계 — 설정에 실패해도 연결은 계속한다(단계만 ✗로 보인다).
fn approvals_step(mode: &str) -> serde_json::Value { step("approvals", mode != "failed", mode) }

fn openclaw_connect(mut run: impl FnMut(&[&str]) -> (bool, String), install: impl FnOnce() -> Result<usize, String>, url: &str, agents: &[AgentSetup]) -> (bool, &'static str, Vec<serde_json::Value>) {
    let (v_ok, v_out) = run(&["--version"]);
    if let Some(have) = openclaw_version_problem(v_ok, &v_out) {
        return (false, "openclaw_outdated", agents.iter().map(|a| serde_json::json!({ "id": a.id, "ok": false, "version": have, "steps": [step("plugin", false, have.clone())] })).collect());
    }
    let mut common = Vec::new();
    let plugin_ok = match install() { Ok(n) => { common.push(step("plugin", true, format!("{n} files"))); true }, Err(e) => { common.push(step("plugin", false, e)); false } };
    let plugin_ok = plugin_ok && openclaw_enable_plugin(&mut run, &mut common);
    let mut results = Vec::new();
    let mut all_ok = true;
    for a in agents {
        let mut steps = common.clone();
        let ok = plugin_ok && (|| -> bool {
            let base = format!("channels.argo-msgr.accounts[{}]", a.id);
            for (k, v) in [("url", url), ("token", a.token.as_str()), ("enabled", "true")] {
                let (ok, out) = run(&["config", "set", &format!("{base}.{k}"), v]);
                if !ok { steps.push(step("env", false, out)); return false; }
            }
            steps.push(step("env", true, format!("openclaw.json {base}")));
            let (b_ok, b_out) = run(&["config", "get", "bindings", "--json"]);
            let Some(bindings) = openclaw_bindings(b_ok, &b_out) else { steps.push(step("enable", false, if b_out.trim().is_empty() { "Invalid bindings config".to_string() } else { b_out })); return false; };
            let json = serde_json::to_string(&merge_binding(bindings, &a.id)).unwrap();
            let (b_ok, b_out) = run(&["config", "set", "bindings", &json]);
            steps.push(step("enable", b_ok, b_out)); b_ok
        })();
        all_ok &= ok;
        results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
    }
    let approvals = all_ok.then(|| approvals_step(openclaw_default_ask(&mut run)));
    let (g_ok, g_out) = if all_ok { run(&["gateway", "restart"]) } else { (false, "Configuration failed; gateway unchanged".into()) };
    let (g_ok, g_out) = if g_ok || !all_ok { (g_ok, g_out) } else { let (i_ok, i_out) = run(&["gateway", "install"]); if i_ok { run(&["gateway", "start"]) } else { (false, format!("{g_out}\n{i_out}")) } };
    all_ok &= g_ok;
    for r in results.iter_mut() { if !g_ok { r["ok"] = false.into(); } if let Some(arr) = r.get_mut("steps").and_then(|s| s.as_array_mut()) { arr.extend(approvals.clone()); arr.push(step("gateway", g_ok, g_out.clone())); } }
    (all_ok, if all_ok { "" } else { "gateway" }, results)
}

/// 헤르메스 프로필 하나 연결: 플러그인 → .env → 활성화 → 승인 모드 기본값 → 게이트웨이. `run`은 그 프로필의 HERMES_HOME으로 CLI를 실행한다.
fn hermes_connect_one(hh: &Path, mut run: impl FnMut(&[&str]) -> (bool, String), install: impl FnOnce() -> Result<usize, String>, url: &str, token: &str) -> (bool, Vec<serde_json::Value>) {
    let mut steps = Vec::new();
    let ok = (|| -> bool {
        match install() { Ok(n) => steps.push(step("plugin", true, format!("{n} files"))), Err(e) => { steps.push(step("plugin", false, e)); return false; } }
        match write_env(&hh.join(".env"), &[("ARGO_MSGR_URL", url), ("ARGO_MSGR_BOT_TOKEN", token)]) { Ok(()) => steps.push(step("env", true, hh.join(".env").display().to_string())), Err(e) => { steps.push(step("env", false, e)); return false; } }
        let (e_ok, e_out) = run(&["plugins", "enable", "argo-msgr-platform", "--no-allow-tool-override"]);
        steps.push(step("enable", e_ok, e_out)); if !e_ok { return false; }
        steps.push(approvals_step(hermes_default_manual(hh, &mut run)));
        let (_, st) = run(&["gateway", "status"]);
        let (g_ok, g_out) = if hermes_gateway_running(&st) { run(&["gateway", "restart"]) } else {
            let (i_ok, i_out) = run(&["gateway", "install"]);
            if i_ok { run(&["gateway", "start"]) } else { (false, i_out) }
        };
        steps.push(step("gateway", g_ok, g_out)); g_ok
    })();
    (ok, steps)
}

fn hermes_profile_path(cli: &Path, name: &str, h: &Path) -> PathBuf {
    let (_, out) = run(cli, &["profile", "show", name]);
    out.lines().find_map(|l| l.trim().strip_prefix("Path:").map(|p| PathBuf::from(p.trim()))).unwrap_or_else(|| if name == "default" { h.join(".hermes") } else { h.join(".hermes/profiles").join(name) })
}

fn hermes_gateway_running(status: &str) -> bool {
    let status = status.to_ascii_lowercase();
    status.contains("gateway is running")
        || status.contains("gateway is supervised by launchd")
        || status.contains("gateway service is running")
        || status.contains("gateway process running")
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
        match openclaw_agents(|args| run(&cli, args)) {
            Ok(found) => found.into_iter().map(|(id, def)| serde_json::json!({ "id": id, "name": if id == "main" { "OpenClaw".to_string() } else { id.clone() }, "default": def })).collect(),
            Err(OpenclawListError::Outdated(have)) => return Ok(serde_json::json!({ "ok": false, "reason": "openclaw_outdated", "version": have, "agents": [] })),
            Err(OpenclawListError::Cli(out)) => return Err(out),
        }
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
    let mut reason = "";
    if kind == "hermes" {
        for a in &agents {
            let hh = if a.home.is_empty() { h.join(".hermes") } else { PathBuf::from(&a.home) };
            let env = [("HERMES_HOME", hh.display().to_string())];
            let (ok, steps) = hermes_connect_one(&hh, |args| run_env(&cli, args, &env), || copy_dir(&res_dir.join("agents/hermes-argo-msgr"), &hh.join("plugins/argo-msgr")), &url, &a.token);
            all_ok &= ok;
            results.push(serde_json::json!({ "id": a.id, "ok": ok, "steps": steps }));
        }
    } else {
        let (ok, why, r) = openclaw_connect(|args| run(&cli, args), || copy_dir(&res_dir.join("agents/openclaw-argo-msgr"), &h.join(".openclaw/extensions").join(OPENCLAW_PLUGIN_ID)), &url, &agents);
        all_ok = ok; reason = why; results = r;
    }
    if reason.is_empty() && !all_ok { reason = "gateway"; }
    Ok(serde_json::json!({ "ok": all_ok, "reason": reason, "cli": cli.display().to_string(), "results": results }))
}

#[cfg(test)]
mod tests {
    use super::{upsert_env, parse_hermes_profiles, parse_openclaw_agents, merge_binding, batch_command_line, installation_id, redact, hermes_gateway_running};
    use super::{openclaw_agents, openclaw_bindings, openclaw_connect, openclaw_version_problem, AgentSetup, yaml_sets, hermes_default_manual, hermes_connect_one};
    #[cfg(target_os = "macos")]
    #[test]
    fn agent_commands_preserve_environment_and_suppress_node_title() {
        let node = super::find_cli("node").expect("system Node required for integration test");
        let dir = std::env::temp_dir().join(format!("argo messenger dock {}", std::process::id()));
        let script = "const before=process.title;process.title='argo-title-test';process.stdout.write(JSON.stringify({blocked:process.title===before,marker:process.env.ARGO_DOCK_TEST,colors:process.env.NO_COLOR,flags:process.env.NODE_OPTIONS}))";
        let env = [("NODE_OPTIONS", "--no-warnings".to_string()), ("ARGO_DOCK_TEST", "preserved".to_string())];
        let (ok, out) = super::run_env_with_home(&node, &["-e", script], &env, Some(&dir));
        assert!(ok, "{out}");
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["blocked"], true);
        assert_eq!(value["marker"], "preserved");
        assert_eq!(value["colors"], "1");
        assert!(value["flags"].as_str().unwrap().contains("--no-warnings"));
        let blocked_home = dir.join("file"); std::fs::write(&blocked_home, "not a directory").unwrap();
        let (ok, out) = super::run_env_with_home(&node, &["-p", "process.env.NODE_OPTIONS"], &env, Some(&blocked_home));
        assert!(ok, "{out}"); assert_eq!(out.trim(), "--no-warnings");
        let (ok, out) = super::run_env_with_home(&node, &["-e", "console.error('argo_bot_test');process.exit(7)"], &env, Some(&dir));
        assert!(!ok); assert_eq!(out.trim(), "[redacted]");
        std::fs::remove_dir_all(dir).unwrap();
    }
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
    fn launchd_supervised_gateway_is_restarted_after_credential_update() {
        assert!(hermes_gateway_running("✓ Gateway is supervised by launchd (PID 98041)"));
        assert!(hermes_gateway_running("✓ Gateway is running"));
        assert!(hermes_gateway_running("✓ User gateway service is running"));
        assert!(hermes_gateway_running("✓ Gateway process running (PID: 98041)"));
        assert!(!hermes_gateway_running("Gateway is not installed"));
    }
    // ── 오픈클로(2026-09-29): server-connect/connect.py와 같은 판정. 가짜 CLI는 test/server-connect.test.mjs의 fakeOpenclaw와 같은 출력을 낸다
    // (실측 근거: 격리 설치 openclaw@2026.9.6). 실제 openclaw는 실행하지 않는다.
    const OC_AGENTS_TEXT: &str = "Agents:\n- main (default)\n  Workspace: ~/.openclaw/workspace\n  Routing rules: 1\n  Providers:\n    - Argo Messenger main: configured\n    - Telegram default: configured\n- support\n  Workspace: ~/.openclaw/workspace-support\nRouting rules map channel/account/peer to an agent.\n";
    const OC_AGENTS_JSON: &str = r#"[{"id":"main","workspace":"/w","bindings":1,"isDefault":true},{"id":"support","workspace":"/w2","bindings":0,"isDefault":false}]"#;
    const OC_UNSET: &str = "{\n  \"ok\": false,\n  \"error\": {\n    \"type\": \"cli_error\",\n    \"message\": \"Config path is valid but unset: bindings. The runtime default applies until you set an authored value with openclaw config set bindings <value>.\"\n  }\n}";
    const OC_LOADED: &str = r#"{"plugin":{"id":"openclaw-argo-msgr","status":"loaded","error":null},"diagnostics":[]}"#;
    const OC_LOAD_FAILED: &str = r#"{"plugin":{"id":"openclaw-argo-msgr","status":"error","error":"Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './plugin-sdk' is not defined by \"exports\""},"diagnostics":[{"level":"error","message":"plugin failed during load"}]}"#;

    struct FakeOpenclaw { version: String, agents_json: Option<String>, inspect: String, calls: Vec<String>, refreshed: bool, bindings: Option<String>, exec_mode: Option<String> }
    impl FakeOpenclaw {
        fn new() -> Self { FakeOpenclaw { version: "OpenClaw 2026.9.6 (eb377ac)".into(), agents_json: Some(OC_AGENTS_JSON.into()), inspect: OC_LOADED.into(), calls: Vec::new(), refreshed: false, bindings: None, exec_mode: None } }
        fn call(&mut self, args: &[&str]) -> (bool, String) {
            self.calls.push(args.join(" "));
            match args {
                ["--version"] => (true, self.version.clone()),
                ["agents", "list", "--json"] => match &self.agents_json { Some(j) => (true, j.clone()), None => (false, "error: unknown option '--json'".into()) },
                ["agents", "list"] => (true, OC_AGENTS_TEXT.into()),
                ["config", "get", "bindings", "--json"] => match &self.bindings { Some(b) => (true, b.clone()), None => (false, OC_UNSET.into()) },
                ["config", "set", "bindings", v] => { self.bindings = Some(v.to_string()); (true, String::new()) },
                // 실측(openclaw@2026.9.6): 값이 없으면 rc=1 + "Config path is valid but unset: tools.exec.mode…", 있으면 rc=0 + JSON 문자열
                ["config", "get", "tools.exec.mode"] => match &self.exec_mode { Some(m) => (true, format!("\"{m}\"\n")), None => (false, OC_UNSET.replace("bindings", "tools.exec.mode")) },
                ["config", "set", "tools.exec.mode", v] => { self.exec_mode = Some(v.to_string()); (true, String::new()) },
                ["config", "set", ..] => (true, String::new()),
                ["plugins", "registry", "--refresh"] => { self.refreshed = true; (true, String::new()) },
                // 게이트웨이가 돌고 있으면 enable은 게이트웨이의 저장된 플러그인 목록으로 판정한다 — 목록을 다시 만들기 전에는 방금 복사한 폴더를 모른다
                ["plugins", "enable", _] => if self.refreshed { (true, "Enabled plugin".into()) } else { (false, "[openclaw] Reason: plugin not installed: openclaw-argo-msgr".into()) },
                ["plugins", "inspect", "openclaw-argo-msgr", "--runtime", "--json"] => (true, self.inspect.clone()),
                ["gateway", _] => (true, String::new()),
                _ => (false, format!("unexpected: {}", args.join(" "))),
            }
        }
    }
    fn oc_agent(id: &str) -> AgentSetup { AgentSetup { id: id.into(), token: format!("argo_bot_{}", "a".repeat(48)), home: String::new() } }
    fn step_details(results: &[serde_json::Value]) -> String { results.iter().flat_map(|r| r["steps"].as_array().cloned().unwrap_or_default()).map(|s| s["detail"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join("\n") }

    // 1-b(2026-09-29 유건 결정): 앱 안 로컬 연결도 VPS 연결(connect.py)과 같이 — 명시한 값이 없을 때만 Hermes manual·OpenClaw ask, 있으면 그대로.
    // 빠져 있으면 Hermes smart·OpenClaw full로 남아 결재 카드 없이 위험 명령이 실행된다.
    #[test]
    fn yaml_sets_matches_connect_py_rules() {
        assert!(yaml_sets("approvals:\n  mode: smart\n", "approvals", "mode"));
        assert!(yaml_sets("approvals: {mode: off, timeout: 60}\n", "approvals", "mode"));
        assert!(yaml_sets("model: x\napprovals:\n  # 주석\n\n  timeout: 60\n  mode: manual\nother: 1\n", "approvals", "mode"));
        assert!(!yaml_sets("approvals:\n  timeout: 60\nmode: smart\n", "approvals", "mode"), "다른 최상위 키의 mode는 아니다");
        assert!(!yaml_sets("auxiliary:\n  approvals:\n    mode: smart\n", "approvals", "mode"), "중첩된 같은 이름은 아니다");
        assert!(!yaml_sets("approvals:\n  gateway:\n    mode: strict\n  timeout: 60\n", "approvals", "mode"), "더 깊은 mode는 아니다");
        assert!(!yaml_sets("approvals: {timeout: 60, submode: x}\n", "approvals", "mode"), "한 줄 형식에서 다른 키 끝의 mode는 아니다");
        assert!(!yaml_sets("approvalsx:\n  mode: smart\n", "approvals", "mode"));
        assert!(!yaml_sets("", "approvals", "mode"));
        assert!(yaml_sets("approvals:\r  mode: smart\r", "approvals", "mode"), "CR만 쓰는 줄끝");
        assert!(yaml_sets("approvals:\r\n  mode: smart\r\n", "approvals", "mode"), "CRLF");
        assert!(yaml_sets("approvals:\u{85}  mode: smart\u{85}", "approvals", "mode"), "NEL");
        assert!(yaml_sets("\u{feff}approvals:\n  mode: smart\n", "approvals", "mode"), "BOM으로 시작하는 파일(Windows 편집기)");
    }
    #[test]
    fn hermes_connect_defaults_to_manual_only_when_unset() {
        let dir = std::env::temp_dir().join(format!("argo-hermes-approvals-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut calls = Vec::new();
        assert_eq!(hermes_default_manual(&dir, |a| { calls.push(a.join(" ")); (true, String::new()) }), "manual");
        assert_eq!(calls, vec!["config set approvals.mode manual"]);
        std::fs::write(dir.join("config.yaml"), "approvals:\n  mode: smart\n").unwrap();
        assert_eq!(hermes_default_manual(&dir, |_| panic!("명시한 smart는 덮어쓰지 않는다")), "kept");
        std::fs::write(dir.join("config.yaml"), "model: x\n").unwrap();
        assert_eq!(hermes_default_manual(&dir, |_| (false, "boom".into())), "failed", "설정 실패는 보고만");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn hermes_connect_sets_manual_before_gateway_restart() {
        let dir = std::env::temp_dir().join(format!("argo-hermes-connect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut calls: Vec<String> = Vec::new();
        let (ok, steps) = hermes_connect_one(&dir, |a| { calls.push(a.join(" ")); (true, if a == ["gateway", "status"] { "Gateway is running".into() } else { String::new() }) }, || Ok(3), "https://x", &format!("argo_bot_{}", "a".repeat(48)));
        assert!(ok, "{calls:?}");
        let set = calls.iter().position(|c| c == "config set approvals.mode manual").expect("manual로 설정");
        assert!(set < calls.iter().position(|c| c == "gateway restart").unwrap(), "게이트웨이 재시작 전에 설정해야 새 값이 적용된다");
        assert!(steps.iter().any(|s| s["name"] == "approvals" && s["ok"] == true && s["detail"] == "manual"), "{steps:?}");
        let mut calls2: Vec<String> = Vec::new();
        let (ok, _) = hermes_connect_one(&dir, |a| { calls2.push(a.join(" ")); (a[0] != "plugins", String::new()) }, || Ok(3), "https://x", "t");
        assert!(!ok && !calls2.iter().any(|c| c.contains("approvals")), "활성화가 실패하면 설정을 건드리지 않는다");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn openclaw_connect_sets_ask_before_gateway_restart_unless_authored() {
        let mut fake = FakeOpenclaw::new();
        let (ok, _, results) = openclaw_connect(|a| fake.call(a), || Ok(3), "https://x/functions/v1/msgr-bot", &[oc_agent("main"), oc_agent("support")]);
        assert!(ok, "{}", fake.calls.join("\n"));
        assert_eq!(fake.exec_mode.as_deref(), Some("ask"));
        let set = fake.calls.iter().position(|c| c == "config set tools.exec.mode ask").expect("ask로 설정");
        assert!(set < fake.calls.iter().position(|c| c == "gateway restart").unwrap(), "게이트웨이 재시작 전에 설정해야 새 값이 적용된다");
        assert_eq!(fake.calls.iter().filter(|c| c.starts_with("config set tools.exec.mode")).count(), 1, "전역 설정이라 한 번만");
        for r in &results { assert!(r["steps"].as_array().unwrap().iter().any(|s| s["name"] == "approvals" && s["ok"] == true && s["detail"] == "ask"), "{r}"); }

        let mut authored = FakeOpenclaw::new(); authored.exec_mode = Some("full".into());
        let (ok, _, results) = openclaw_connect(|a| authored.call(a), || Ok(3), "https://x", &[oc_agent("main")]);
        assert!(ok); assert_eq!(authored.exec_mode.as_deref(), Some("full"), "명시한 full은 덮어쓰지 않는다");
        assert!(results[0]["steps"].as_array().unwrap().iter().any(|s| s["name"] == "approvals" && s["detail"] == "kept"));

        let mut slow = FakeOpenclaw::new(); slow.exec_mode = Some("full".into());
        let mut calls = Vec::new();
        assert_eq!(super::openclaw_default_ask(&mut |a: &[&str]| { calls.push(a.join(" ")); if a[1] == "get" { (false, "timed out".to_string()) } else { slow.call(a) } }), "failed");
        assert!(!calls.iter().any(|c| c.starts_with("config set")), "조회 실패(시간 초과)를 '값 없음'으로 보고 full을 덮지 않는다");

        let mut broken = FakeOpenclaw::new(); broken.inspect = OC_LOAD_FAILED.into();
        let _ = openclaw_connect(|a| broken.call(a), || Ok(3), "https://x", &[oc_agent("main")]);
        assert!(!broken.calls.iter().any(|c| c.contains("tools.exec.mode")), "연결이 실패하면 설정을 건드리지 않는다");
    }
    #[test]
    fn openclaw_first_install_without_bindings_connects() {
        // 최신 CLI는 바인딩이 없을 때 rc=1 + {"ok":false,"error":{"message":"Config path is valid but unset: bindings…"}}, 예전 CLI는 "Config path not found: bindings"
        assert_eq!(openclaw_bindings(false, OC_UNSET), Some(vec![]));
        assert_eq!(openclaw_bindings(false, "Config path not found: bindings"), Some(vec![]));
        assert_eq!(openclaw_bindings(false, "Config path not found: bindingsX"), None);
        assert_eq!(openclaw_bindings(false, "EACCES: permission denied, open '~/.openclaw/openclaw.json'"), None);
        assert_eq!(openclaw_bindings(true, "null"), Some(vec![]));
        assert_eq!(openclaw_bindings(true, "Warning: config has unknown keys\n[{\"agentId\":\"x\"}]"), Some(vec![serde_json::json!({"agentId":"x"})]));
        assert_eq!(openclaw_bindings(true, "{\"not\":\"a list\"}"), None);
        let mut fake = FakeOpenclaw::new();
        let (ok, reason, results) = openclaw_connect(|a| fake.call(a), || Ok(3), "https://x/functions/v1/msgr-bot", &[oc_agent("main")]);
        assert!(ok, "{}\n{}", fake.calls.join("\n"), step_details(&results)); assert_eq!(reason, "");
        assert_eq!(serde_json::from_str::<serde_json::Value>(fake.bindings.as_deref().unwrap()).unwrap(), serde_json::json!([{ "match": { "channel": "argo-msgr", "accountId": "main" }, "agentId": "main" }]));
        assert!(fake.calls.contains(&"gateway restart".to_string()));
    }
    #[test]
    fn openclaw_agents_read_json_first_and_skip_indented_channel_lines() {
        assert_eq!(parse_openclaw_agents(OC_AGENTS_TEXT), vec![("main".to_string(), true), ("support".to_string(), false)], "\"Argo\"·\"Telegram\" 채널 줄은 에이전트가 아니다");
        let mut fake = FakeOpenclaw::new();
        assert_eq!(openclaw_agents(|a| fake.call(a)).unwrap(), vec![("main".to_string(), true), ("support".to_string(), false)]);
        assert!(fake.calls.contains(&"agents list --json".to_string()), "{:?}", fake.calls);
        assert!(!fake.calls.contains(&"agents list".to_string()), "JSON이 되면 텍스트 목록을 읽지 않는다");
        let mut old = FakeOpenclaw::new(); old.agents_json = None;
        assert_eq!(openclaw_agents(|a| old.call(a)).unwrap(), vec![("main".to_string(), true), ("support".to_string(), false)]);
        assert_eq!(old.calls.last().map(String::as_str), Some("agents list"));
    }
    #[test]
    fn openclaw_plugin_registry_is_refreshed_before_enable_and_load_is_checked_after() {
        let mut fake = FakeOpenclaw::new();
        let (ok, _, results) = openclaw_connect(|a| fake.call(a), || Ok(3), "https://x", &[oc_agent("main")]);
        assert!(ok, "{}\n{}", fake.calls.join("\n"), step_details(&results));
        let at = |c: &str| fake.calls.iter().position(|x| x == c).unwrap_or_else(|| panic!("missing {c}: {:?}", fake.calls));
        assert!(at("plugins registry --refresh") < at("plugins enable openclaw-argo-msgr"));
        assert!(at("plugins enable openclaw-argo-msgr") < at("plugins inspect openclaw-argo-msgr --runtime --json"), "켠 뒤에 실제 로드를 확인한다");
        let first_write = fake.calls.iter().position(|c| c.starts_with("config set")).expect("config set");
        assert!(at("plugins inspect openclaw-argo-msgr --runtime --json") < first_write, "로드 확인 뒤에 계정을 쓴다");
        assert!(!fake.calls.iter().any(|c| c.starts_with("plugins list")), "plugins list는 깨진 플러그인도 loaded로 보여 판정에 쓰지 않는다");
    }
    #[test]
    fn openclaw_plugin_that_does_not_load_fails_without_writing_accounts() {
        let mut fake = FakeOpenclaw::new(); fake.inspect = OC_LOAD_FAILED.into();
        let (ok, _, results) = openclaw_connect(|a| fake.call(a), || Ok(3), "https://x", &[oc_agent("main"), oc_agent("support")]);
        assert!(!ok);
        assert!(results.iter().all(|r| r["ok"] == false), "{results:?}");
        let details = step_details(&results);
        assert!(details.contains("ERR_PACKAGE_PATH_NOT_EXPORTED"), "{details}");
        assert!(!fake.calls.iter().any(|c| c.starts_with("config set") || c.starts_with("gateway")), "계정·바인딩을 쓰지 않고 게이트웨이도 건드리지 않는다: {:?}", fake.calls);
        let mut broken = FakeOpenclaw::new(); broken.inspect = "Plugin not found: openclaw-argo-msgr".into();
        let (ok, _, _) = openclaw_connect(|a| broken.call(a), || Ok(3), "https://x", &[oc_agent("main")]);
        assert!(!ok, "inspect 결과를 읽을 수 없으면 실패로 본다");
    }
    #[test]
    fn openclaw_older_than_2026_8_1_is_not_installed() {
        for (version, have) in [("OpenClaw 2026.2.23 (1a2b3c4)", "2026.2.23"), ("OpenClaw 2026.8.1-beta.3 (1a2b3c4)", "2026.8.1-beta"), ("openclaw: command output without a version", ""), ("OpenClaw 2025.12.9", "2025.12.9")] {
            assert_eq!(openclaw_version_problem(true, version).as_deref(), Some(have), "{version} must be rejected with the detected version");
            let mut fake = FakeOpenclaw::new(); fake.version = version.into();
            assert_eq!(openclaw_agents(|a| fake.call(a)).unwrap_err(), super::OpenclawListError::Outdated(have.into()));
            assert_eq!(fake.calls, ["--version"], "목록도 읽지 않는다");
            let mut fake = FakeOpenclaw::new(); fake.version = version.into(); let mut installed = false;
            let (ok, reason, results) = openclaw_connect(|a| fake.call(a), || { installed = true; Ok(3) }, "https://x", &[oc_agent("main")]);
            assert!(!ok); assert_eq!(reason, "openclaw_outdated", "화면이 사전 문구로 번역하는 사유 코드");
            assert!(!installed, "플러그인을 복사하지 않는다"); assert_eq!(fake.calls, ["--version"]);
            assert_eq!(results[0]["version"], have);
        }
        assert!(openclaw_version_problem(false, "OpenClaw 2026.9.6").is_some(), "--version이 실패하면 읽을 수 없는 것으로 본다");
        for version in ["OpenClaw 2026.8.1 (1a2b3c4)", "OpenClaw 2026.9.6 (eb377ac)", "2026.10.2", "OpenClaw 2027.1.1-rc.1"] {
            assert_eq!(openclaw_version_problem(true, version), None, "{version}");
        }
        let mut fake = FakeOpenclaw::new(); fake.version = "OpenClaw 2026.8.1 (1a2b3c4)".into();
        assert!(openclaw_connect(|a| fake.call(a), || Ok(3), "https://x", &[oc_agent("main")]).0);
    }
    #[test]
    fn upsert_replaces_only_matching_keys() {
        let cur = "OTHER=1\nARGO_MSGR_URL=old\n# note\n";
        let next = upsert_env(cur, &[("ARGO_MSGR_URL", "https://x/functions/v1/msgr-bot"), ("ARGO_MSGR_BOT_TOKEN", "argo_bot_x")]);
        assert_eq!(next, "OTHER=1\nARGO_MSGR_URL=https://x/functions/v1/msgr-bot\n# note\nARGO_MSGR_BOT_TOKEN=argo_bot_x\n");
        assert_eq!(upsert_env("", &[("A", "1")]), "A=1\n");
    }
}
