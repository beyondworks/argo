use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const NAME: &str = "update-notes-version";
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 || value.len() > 62 {
        return Err("Expected a release version x.y.z".into());
    }
    let mut parsed = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return Err("Expected a release version x.y.z".into());
        }
        parsed[i] = part.parse().map_err(|_| "Release version is out of range")?;
    }
    Ok(parsed)
}

pub fn read(dir: &Path) -> Result<Option<String>, String> {
    let file = match File::open(dir.join(NAME)) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut value = String::new();
    file.take(63).read_to_string(&mut value).map_err(|e| e.to_string())?;
    version(&value)?;
    Ok(Some(value))
}

fn private_file(path: &Path, create_new: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new { options.create_new(true); } else { options.create(true); }
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

// OS locks serialize separate app processes as well as concurrent IPC calls.
// Closing the handle releases the lock after errors or a process crash.
fn lock(dir: &Path) -> io::Result<File> {
    let file = private_file(&dir.join("update-notes.lock"), false)?;
    let start = Instant::now();
    loop {
        match try_lock(&file) {
            Ok(()) => return Ok(file),
            Err(e) if start.elapsed() < Duration::from_secs(2) && e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    extern "C" { fn flock(fd: i32, operation: i32) -> i32; }
    // LOCK_EX | LOCK_NB have these values on both macOS and Linux.
    if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped { internal: usize, internal_high: usize, offset: u32, offset_high: u32, event: *mut c_void }
    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(file: *mut c_void, flags: u32, reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32;
    }
    let mut overlapped = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: std::ptr::null_mut() };
    if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlapped) } != 0 { return Ok(()); }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(33) { Err(io::Error::from(io::ErrorKind::WouldBlock)) } else { Err(error) }
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> io::Result<()> { fs::rename(from, to) }

#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    const REPLACE_EXISTING: u32 = 1;
    const WRITE_THROUGH: u32 = 8;
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), REPLACE_EXISTING | WRITE_THROUGH) } != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

pub fn acknowledge(dir: &Path, requested: &str, installed: &str) -> Result<String, String> {
    let requested_version = version(requested)?;
    version(installed)?;
    if requested != installed { return Err("Only the installed app version can be acknowledged".into()); }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _lock = lock(dir).map_err(|e| e.to_string())?;
    if let Some(previous) = read(dir)? {
        if version(&previous)? >= requested_version { return Ok(previous); }
    }
    let temp = dir.join(format!("{NAME}.tmp-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> io::Result<()> {
        let mut file = private_file(&temp, true)?;
        file.write_all(requested.as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace(&temp, &dir.join(NAME))
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result.map_err(|e| e.to_string())?;
    Ok(requested.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("argo-update-notes-{}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn absent_save_reopen_replace_and_downgrade() {
        let dir = Temp::new();
        assert_eq!(read(&dir.0).unwrap(), None);
        assert_eq!(acknowledge(&dir.0, "0.1.88", "0.1.88").unwrap(), "0.1.88");
        assert_eq!(read(&dir.0).unwrap().as_deref(), Some("0.1.88"));
        assert_eq!(acknowledge(&dir.0, "0.1.90", "0.1.90").unwrap(), "0.1.90");
        assert_eq!(acknowledge(&dir.0, "0.1.88", "0.1.88").unwrap(), "0.1.90");
        assert_eq!(acknowledge(&dir.0, "0.1.90", "0.1.90").unwrap(), "0.1.90");
        assert_eq!(fs::read_to_string(dir.0.join(NAME)).unwrap(), "0.1.90");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn invalid_future_versions_and_corrupt_file_are_not_overwritten() {
        let dir = Temp::new();
        for bad in ["", "1.2", "v1.2.3", "1.2.3-beta", "01.2.3", "1.2.3\n", "../../x", "1.2.18446744073709551616"] {
            assert!(acknowledge(&dir.0, bad, bad).is_err());
        }
        assert!(acknowledge(&dir.0, "0.1.99", "0.1.88").is_err());
        assert_eq!(read(&dir.0).unwrap(), None);
        fs::write(dir.0.join(NAME), "broken").unwrap();
        assert!(read(&dir.0).is_err());
        assert!(acknowledge(&dir.0, "0.1.88", "0.1.88").is_err());
        assert_eq!(fs::read_to_string(dir.0.join(NAME)).unwrap(), "broken");
    }

    #[test]
    fn io_failure_is_reported_without_destroying_existing_state() {
        let dir = Temp::new();
        acknowledge(&dir.0, "1.2.3", "1.2.3").unwrap();
        assert!(acknowledge(&dir.0.join(NAME), "1.2.4", "1.2.4").is_err());
        assert_eq!(read(&dir.0).unwrap().as_deref(), Some("1.2.3"));
        assert!(replace(&dir.0.join("missing"), &dir.0.join(NAME)).is_err());
        assert_eq!(read(&dir.0).unwrap().as_deref(), Some("1.2.3"));
    }

    #[test]
    fn concurrent_calls_preserve_highest_version() {
        let dir = Temp::new();
        std::thread::scope(|scope| {
            for n in (0..20).rev() {
                let path = &dir.0;
                scope.spawn(move || { let v = format!("1.0.{n}"); acknowledge(path, &v, &v).unwrap(); });
            }
        });
        assert_eq!(read(&dir.0).unwrap().as_deref(), Some("1.0.19"));
    }

    #[test]
    fn process_writer() {
        let Some(dir) = std::env::var_os("ARGO_UPDATE_NOTES_TEST_DIR") else { return; };
        let v = std::env::var("ARGO_UPDATE_NOTES_TEST_VERSION").unwrap();
        acknowledge(Path::new(&dir), &v, &v).unwrap();
    }

    #[test]
    fn concurrent_processes_preserve_highest_version() {
        let dir = Temp::new();
        let mut children = Vec::new();
        for n in (0..8).rev() {
            children.push(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::process_writer"])
                .env("ARGO_UPDATE_NOTES_TEST_DIR", &dir.0).env("ARGO_UPDATE_NOTES_TEST_VERSION", format!("2.0.{n}"))
                .stdout(std::process::Stdio::null()).spawn().unwrap());
        }
        for mut child in children { assert!(child.wait().unwrap().success()); }
        assert_eq!(read(&dir.0).unwrap().as_deref(), Some("2.0.7"));
    }
}
