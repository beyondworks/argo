//! Shared macOS Node preload for both native shells. Kept byte-identical to
//! JS SHIM_SRC by test/native-no-dock.test.mjs; no runtime bundle-file dependency.
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub const SHIM: &str = include_str!("no-dock.cjs");
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn tokens(value: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' if quoted => { word.push(chars.next()?); started = true; }
            '"' => { quoted = !quoted; started = true; }
            ' ' if !quoted => { if started { words.push(std::mem::take(&mut word)); started = false; } }
            _ => { word.push(c); started = true; }
        }
    }
    if quoted { return None; }
    if started { words.push(word); }
    Some(words)
}

fn compose(previous: Option<&str>, path: &Path) -> Result<String, String> {
    let p = path.to_str().ok_or("Non-UTF-8 preload path")?;
    let previous = previous.unwrap_or("").trim();
    if let Some(words) = tokens(previous) {
        if words.iter().enumerate().any(|(i, w)| {
            ((w == "--require" || w == "-r") && words.get(i + 1).is_some_and(|next| next == p))
                || w.strip_prefix("--require=") == Some(p)
        }) { return Ok(previous.to_string()); }
    }
    let escaped = p.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("--require \"{escaped}\"{}{}", if previous.is_empty() { "" } else { " " }, previous))
}

/// Write a complete private shim atomically. A failed prepare must not change
/// the caller's NODE_OPTIONS; callers retain their original environment.
pub fn prepare(home: &Path, previous: Option<&str>) -> Result<String, String> {
    let dir = home.join(".argo/tools");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join("no-dock.cjs");
    let options = compose(previous, &dest)?;
    let tmp = dir.join(format!("no-dock.cjs.tmp-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
        let mut file = opts.open(&tmp)?;
        file.write_all(SHIM.as_bytes())?;
        fs::rename(&tmp, &dest)
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result.map_err(|e| e.to_string())?;
    Ok(options)
}

/// Probe only a supplied Node executable; bounded failure kills and reaps it.
/// Messenger resolves this from its CLI PATH, never from the installed Argo app.
#[allow(dead_code)]
pub fn validate(node: &Path, options: &str, timeout: std::time::Duration) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(node).args(["-e", ""])
        .env("NODE_OPTIONS", options).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err("Node preload probe failed".into()) },
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(std::time::Duration::from_millis(10)),
            other => {
                let _ = child.kill(); let _ = child.wait();
                return Err(match other { Err(e) => e.to_string(), _ => "Node preload probe timed out".into() });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_tokens_and_escaped_paths() {
        let path = Path::new("/tmp/a b/\"c\\d.cjs");
        let composed = compose(Some("--no-warnings"), path).unwrap();
        assert_eq!(tokens(&composed).unwrap(), ["--require", path.to_str().unwrap(), "--no-warnings"]);
        assert_eq!(compose(Some(&composed), path).unwrap(), composed);
        let path = Path::new("/tmp/no-dock.cjs");
        for prev in ["--require=/tmp/no-dock.cjs", "-r \"/tmp/no-dock.cjs\""] {
            assert_eq!(compose(Some(prev), path).unwrap(), prev);
        }
        assert_ne!(compose(Some("--require /tmp/no-dock.cjs.backup"), path).unwrap(), "--require /tmp/no-dock.cjs.backup");
    }

    #[test]
    fn concurrent_preparation_keeps_complete_private_payload() {
        let home = std::env::temp_dir().join(format!("argo-native-dock-{}", std::process::id()));
        std::thread::scope(|scope| { for _ in 0..8 { let h = &home; scope.spawn(move || prepare(h, Some("--no-warnings")).unwrap()); } });
        let path = home.join(".argo/tools/no-dock.cjs");
        assert_eq!(fs::read_to_string(&path).unwrap(), SHIM);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600); }
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_node_preload_survives_escaped_path_and_child_inheritance() {
        let node = std::env::var_os("ARGO_TEST_NODE").unwrap_or_else(|| "node".into());
        let home = std::env::temp_dir().join(format!("argo-native-dock-quoted-{}-\"\\", std::process::id()));
        let options = prepare(&home, Some("--no-warnings")).unwrap();
        validate(Path::new(&node), &options, std::time::Duration::from_secs(2)).unwrap();
        let script = "const before=process.title; process.title='test'; if(process.title!==before)process.exit(1); const r=require('child_process').spawnSync(process.execPath,['-e',\"const old=process.title;process.title='child';process.exit(process.title===old?0:1)\"]);process.exit(r.status)";
        let status = std::process::Command::new(&node).args(["-e", script]).env("NODE_OPTIONS", &options).status().unwrap();
        fs::remove_dir_all(home).unwrap();
        assert!(status.success());
        assert!(validate(Path::new(&node), "--definitely-invalid", std::time::Duration::from_secs(2)).is_err());
        assert!(validate(Path::new("/bin/sleep"), "", std::time::Duration::ZERO).is_err());
    }
}
