// 진단 로그 — 출시 빌드에서도 사이드카(내장 Node 서버) stdout/stderr와 부트 상태를 파일로 남긴다.
// 예전에는 tauri-plugin-log를 디버그 빌드에서만 켜서, 출시 앱 사용자의 "메신저 일을 안 받음"·"동기화가 안 됨"을
// 원인 확정할 수 없었다(0.1.120 핫픽스). 위치는 Tauri app_log_dir:
//   맥 ~/Library/Logs/com.beyondworks.argo/server.log, 윈도우 %LOCALAPPDATA%\com.beyondworks.argo\logs\server.log
// 크기 상한: 파일 하나 5MB, server.log + server.1.log + server.2.log 세 개까지(최대 약 15MB). 넘으면 가장 오래된 것을 버린다.
// 민감 정보: 쓰기 직전에 redact()로 토큰·키·DB 주소·이메일을 가린다 — 행동 시험은 아래 tests.
use regex::Regex;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const FILE_NAME: &str = "server.log";
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP_FILES: usize = 3; // 현재 파일 포함
const MAX_LINE: usize = 8 * 1024; // 한 줄 상한 — 거대한 덤프 한 줄이 회전 단위를 혼자 채우지 않게

struct Rules(Vec<(Regex, &'static str)>);

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("diag_log redact pattern");
        // 순서가 뜻이 있다: DB 주소(안에 @가 있다) → Bearer → JWT → 벤더 키 → key=value → 이메일.
        Rules(vec![
            (r(r"(?i)\bpostgres(?:ql)?://[^\s\x22'<>]+"), "postgresql://[REDACTED]"),
            (r(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
            (r(r"\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}"), "[REDACTED_JWT]"),
            (r(r"\bsk-[A-Za-z0-9_-]{8,}"), "sk-[REDACTED]"),
            (r(r"\bsb_secret_[A-Za-z0-9_-]{8,}"), "sb_secret_[REDACTED]"),
            (
                r(r"(?i)\b(access_token|refresh_token|id_token|api[_-]?key|client_secret|password|secret|token)(\s*[\x22']?\s*[:=]\s*[\x22']?)[^\s\x22'&,;}]+"),
                "${1}${2}[REDACTED]",
            ),
            (r(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
        ])
    })
}

/// 로그 한 줄에서 알려진 비밀 모양을 가린다. 모르는 모양까지 막는 장치는 아니다 — 서버 쪽에서 비밀을 찍지 않는 것이 먼저다.
pub fn redact(line: &str) -> String {
    let mut s = line.to_string();
    for (re, rep) in &rules().0 {
        if re.is_match(&s) {
            s = re.replace_all(&s, *rep).into_owned();
        }
    }
    s
}

/// 크기 상한 회전 파일. 쓰기 실패는 조용히 버린다 — 로그 때문에 앱이 멈추거나 죽으면 안 된다.
pub struct RotatingLog {
    dir: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub fn new(dir: PathBuf, max_bytes: u64, keep: usize) -> Self {
        let mut l = RotatingLog { dir, max_bytes, keep: keep.max(1), file: None, size: 0 };
        l.reopen();
        l
    }

    fn path(&self, n: usize) -> PathBuf {
        if n == 0 { self.dir.join(FILE_NAME) } else { self.dir.join(format!("server.{n}.log")) }
    }

    fn reopen(&mut self) {
        let _ = fs::create_dir_all(&self.dir);
        let p = self.path(0);
        self.file = OpenOptions::new().create(true).append(true).open(&p).ok();
        self.size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    }

    fn rotate(&mut self) {
        self.file = None; // 윈도우는 열린 파일을 rename할 수 없다 — 먼저 닫는다
        let _ = fs::remove_file(self.path(self.keep - 1));
        for n in (0..self.keep - 1).rev() {
            let _ = fs::rename(self.path(n), self.path(n + 1));
        }
        self.reopen();
    }

    /// 가림 → 길이 상한 → 시각 머리 → 필요하면 회전 → 덧붙이기.
    pub fn write_line(&mut self, tag: &str, line: &str) {
        let mut text = redact(line);
        if text.len() > MAX_LINE {
            let mut cut = MAX_LINE;
            while !text.is_char_boundary(cut) { cut -= 1; }
            text.truncate(cut);
            text.push_str(" …[truncated]");
        }
        let entry = format!("{} [{tag}] {text}\n", utc_now());
        if self.size > 0 && self.size + entry.len() as u64 > self.max_bytes {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            if f.write_all(entry.as_bytes()).is_ok() {
                self.size += entry.len() as u64;
            }
        }
    }
}

static LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();

/// 앱 시작 때 한 번. 폴더를 못 만들면 파일 없이 넘어간다(쓰기마다 다시 시도).
pub fn init(dir: PathBuf) {
    let _ = LOG.set(Mutex::new(RotatingLog::new(dir, MAX_BYTES, KEEP_FILES)));
}

pub fn write(tag: &str, line: &str) {
    if let Some(m) = LOG.get() {
        if let Ok(mut l) = m.lock() {
            l.write_line(tag, line);
        }
    }
}

/// "진단 로그 폴더 열기" — 파일이 있으면 파인더·탐색기에서 그 파일을 선택해 보여 주고, 없으면 폴더를 연다.
pub fn reveal(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let f = dir.join(FILE_NAME);
    if f.exists() {
        tauri_plugin_opener::reveal_item_in_dir(&f).map_err(|e| e.to_string())
    } else {
        tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
    }
}

/// UTC "YYYY-MM-DDTHH:MM:SSZ" — chrono 없이(일수→날짜는 Howard Hinnant civil_from_days).
fn utc_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    fmt_utc(secs)
}

fn fmt_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 시험용 값은 모양만 흉내 낸 가짜다(실제 키·토큰 아님).
    #[test]
    fn redacts_known_secret_shapes() {
        let jwt = format!("eyJhbGciOiJIUzI1NiJ9.{}.{}", "eyJzdWIiOiJ4In0", "c2lnbmF0dXJlX2Zha2U");
        let cases: Vec<(String, &str)> = vec![
            (format!("auth ok {jwt} done"), "eyJ"),
            // 접두어를 따로 붙인다 — 저장소 pre-commit 비밀 검사가 가짜 값을 진짜로 오인하지 않게
            (format!("calling with {}-ant-api03-FAKEfakeFAKE1234 now", "sk"), "FAKEfakeFAKE1234"),
            ("Authorization: Bearer abc.def-ghi_123".into(), "abc.def-ghi_123"),
            ("authorization: bearer zzzzzzzz".into(), "zzzzzzzz"),
            (format!("db {}://user:pw@db.example.supabase.co:5432/postgres up", "postgresql"), "user:pw"),
            (format!("db {}://u:p@h/db", "postgres"), "u:p@h"),
            ("signed in as someone.name+tag@example.co.kr".into(), "someone.name"),
            ("GET /api/x?token=abcd1234&next=1".into(), "abcd1234"),
            (r#"{"refresh_token":"r3fr3shV4lue","x":1}"#.into(), "r3fr3shV4lue"),
            ("key sb_secret_FAKEfake12345678".into(), "FAKEfake12345678"),
        ];
        for (input, secret) in cases {
            let out = redact(&input);
            assert!(!out.contains(secret), "가려지지 않음: {input} → {out}");
        }
    }

    #[test]
    fn keeps_ordinary_diagnostics_readable() {
        for s in [
            "[msgr] 일 받기 대기 중 (poll 5s)",
            "sync push 3 files, 0 conflicts",
            "task-runner started; risk-free path",
            "input_tokens: 512 output_tokens: 20",
            "installed @anthropic-ai/claude-agent-sdk@0.2.1",
            "▲ Next.js ready on http://127.0.0.1:3011",
        ] {
            assert_eq!(redact(s), s, "평범한 줄이 바뀌면 진단이 어려워진다");
        }
    }

    #[test]
    fn redacted_markers_are_explicit() {
        assert_eq!(redact("Bearer abc123"), "Bearer [REDACTED]");
        assert_eq!(redact("to a@b.io"), "to [REDACTED_EMAIL]");
        assert_eq!(redact("password=hunter2 ok"), "password=[REDACTED] ok");
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("argo-diaglog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn rotates_and_caps_file_count() {
        let d = tmpdir("rot");
        let mut l = RotatingLog::new(d.clone(), 200, 3);
        for i in 0..100 {
            l.write_line("server", &format!("line {i} with some padding text"));
        }
        let names: Vec<String> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 3, "파일 수 상한 3: {names:?}");
        for n in ["server.log", "server.1.log", "server.2.log"] {
            let len = fs::metadata(d.join(n)).unwrap().len();
            assert!(len <= 200, "{n} 크기 {len} > 200");
        }
        let cur = fs::read_to_string(d.join("server.log")).unwrap();
        assert!(cur.contains("line 99"), "가장 최근 줄은 server.log에 있다");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn writes_redacted_timestamped_lines_and_caps_line_length() {
        let d = tmpdir("line");
        let mut l = RotatingLog::new(d.clone(), MAX_BYTES, 3);
        l.write_line("server", "login me@example.com Bearer tok123");
        l.write_line("server", &"가".repeat(10_000));
        let s = fs::read_to_string(d.join(FILE_NAME)).unwrap();
        assert!(!s.contains("me@example.com") && !s.contains("tok123"));
        assert!(s.lines().next().unwrap().contains("Z [server] login [REDACTED_EMAIL] Bearer [REDACTED]"));
        assert!(s.lines().nth(1).unwrap().len() < MAX_LINE + 64 && s.contains("[truncated]"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn utc_format() {
        assert_eq!(fmt_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(fmt_utc(1_798_416_000), "2026-12-28T00:00:00Z");
        assert_eq!(fmt_utc(951_782_400 + 3_661), "2000-02-29T01:01:01Z");
    }
}
