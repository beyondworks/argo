// 데스크톱 셸의 포트 결정 — 이미 뜬 Argo 서버에 붙을지(입양), 앱 서버를 어느 포트에 띄울지.
// 표준 라이브러리만 쓴다: test/desktop-adoption-dock.test.mjs가 이 파일을 rustc로 따로 컴파일해 아래 테스트를
// CI(macOS·Windows)에서 돌린다(본체 crate의 cargo test는 CI에서 돌지 않는다). lib.rs는 결과(Boot·SpawnPlan)를
// 받아 실행만 한다 — SpawnPlan은 밖에서 만들 수 없어, 상주 자리(keep_free)를 호출하는 쪽에서 빠뜨릴 수 없다.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

// 포트 후보 — 3001(상주 서비스·기존 관례) 우선, 선점 시 폴백. public/boot.js의 TARGETS와 일치해야 한다.
pub const PORTS: [u16; 3] = [3001, 3011, 3021];

pub fn tcp_open(port: u16) -> bool {
    TcpStream::connect_timeout(&(([127, 0, 0, 1], port).into()), Duration::from_millis(300)).is_ok()
}

// connect 실패 ≠ bind 가능 — Windows Hyper-V/WinNAT 동적 예약 대역의 포트는 아무도 LISTEN하지
// 않아도 커널이 bind()를 EACCES로 거부한다(실사용 신고 2026-07-27, Win11 24H2 재현: 예약 대역에
// 3001이 걸리면 사이드카가 listen EACCES로 즉사, 재시작으로는 절대 안 풀림). 스폰 전에 실제
// bind로 확인한다 — TcpListener는 즉시 drop되고 loopback+즉시 스폰 흐름이라 TIME_WAIT 무해.
pub fn can_bind(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// 스폰 후보 선택(순수) — tried 제외 + 닫혀 있고(bind 가능) 순서 유지. 판정 함수를 주입받아
// 실소켓 없이 단위 테스트한다(검수 1R: 폴백 로직 무테스트 지적).
fn pick_spawn_port(tried: &[u16], open: impl Fn(u16) -> bool, bindable: impl Fn(u16) -> bool) -> Option<u16> {
    PORTS.iter().copied().find(|&p| !tried.contains(&p) && !open(p) && bindable(p))
}

// 포트의 서버 상태 — /api/ping 한 번으로 가른다. Silent = 연결은 받았는데 답이 없다: next start는 포트를 먼저 열고
// 핸들러가 준비(Ready)될 때까지 요청을 붙잡아 둔다(next/dist/server/lib/start-server.js: listen → handlersPromise).
// 상주가 기동 중이라는 뜻이라 기다릴 근거가 된다. Other = 답이 왔지만 같은 버전 Argo가 아니다(타 앱·다른 버전).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortState { Closed, Silent, SameArgo, Other }

// /api/ping 응답 판정 — 신원 마커 + 같은 버전 + 현재 dockProtocol일 때만 SameArgo.
fn classify_ping(text: &str) -> PortState {
    let is_argo = text.contains("\"argo\":true") || text.contains("\"argo\": true");
    let same_ver = text.contains(&format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION")))
        || text.contains(&format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION")));
    // Version alone can adopt an old resident with the pre-fix spawn paths.
    // Bound the numeric token so a future incompatible protocol is not accepted.
    let dock_protocol = ["\"dockProtocol\":1,", "\"dockProtocol\":1}", "\"dockProtocol\": 1,", "\"dockProtocol\": 1}"]
        .iter().any(|marker| text.contains(marker));
    if is_argo && same_ver && dock_protocol { PortState::SameArgo } else { PortState::Other }
}

// 이 포트의 서버가 "같은 버전의" Argo인가 — /api/ping 신원 마커 + 버전을 최소 HTTP로 확인.
// TCP 열림 ≠ Argo(타 앱 선점·좀비) — 신원 확인 없이는 붙지도, 그 포트를 쓰지도 않는다.
// 버전 대조(2026-07-22 실사용 신고): 버전 불문 adopt는 앱(쉘) 버전과 화면(UI) 버전을 어긋나게 한다 —
// v0.1.20 앱이 상주 v0.1.22 서버에 붙어 "업데이트 안 했는데 다음 버전이 표시"되고, 업데이트 뱃지도
// 무의미해진다. 같은 버전일 때만 붙고(같은 앱 이중 실행 방지라는 원 목적), 다르면 자기 사이드카를
// 다음 빈 포트에 띄운다(상주 서버는 건드리지 않는다).
pub fn probe_port(port: u16) -> PortState {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return PortState::Closed };
    let _ = s.set_write_timeout(Some(Duration::from_millis(300)));
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() { return PortState::Other; }
    let mut buf = Vec::new();
    // 타임아웃/조기 종료여도 읽힌 만큼 판정. 한 바이트도 없이 읽기 상한에 걸렸을 때만 Silent(기동 중) —
    // 바로 끊는 서버(빈 EOF·리셋)는 기동 중이 아니라 Other다.
    let read = s.take(16_384).read_to_end(&mut buf);
    let timed_out = matches!(&read, Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
    if buf.is_empty() && timed_out { return PortState::Silent; }
    classify_ping(&String::from_utf8_lossy(&buf))
}

pub fn is_same_version_argo(port: u16) -> bool {
    probe_port(port) == PortState::SameArgo
}

// 상주 서비스(scripts/service.mjs install)가 맡은 포트 — 맥 LaunchAgent plist의 `next start … -p <포트>`.
// 서비스 기본 포트는 3999지만 ARGO_PORT로 3001에 둔 기기(개발 맥)가 있다. 후보 포트(PORTS)와 겹칠 때만 앱과 자리를 다툰다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn resident_port_from_plist(plist: &str) -> Option<u16> {
    let args = plist.split("<key>ProgramArguments</key>").nth(1)?;
    let args = &args[..args.find("</array>")?];
    let items: Vec<&str> = args.split("<string>").skip(1).filter_map(|s| s.split_once("</string>")).map(|(v, _)| v.trim()).collect();
    items.iter().enumerate().find_map(|(i, a)| match *a {
        "-p" | "--port" => items.get(i + 1)?.parse().ok(),
        _ => a.strip_prefix("--port=")?.parse().ok(),
    })
}

// 라벨은 scripts/service.mjs의 LABEL과 같아야 한다. uninstall은 plist를 지우므로 파일이 있으면 설치된 것으로 본다.
#[cfg(target_os = "macos")]
fn installed_resident_port(home: Option<PathBuf>) -> Option<u16> {
    let plist = std::fs::read_to_string(home?.join("Library/LaunchAgents/com.beyondworks.argo.plist")).ok()?;
    resident_port_from_plist(&plist)
}

// Windows 상주 = 작업 스케줄러 'Argo' + 저장소 안 argo-service.cmd(앱은 그 위치를 모른다) — 판정하려면 schtasks를
// 띄워야 해서 이번에는 보지 않는다(기존 동작 그대로). Linux는 데스크톱 앱 배포가 없다(release.yml: macOS 2종 + Windows).
#[cfg(not(target_os = "macos"))]
fn installed_resident_port(_home: Option<PathBuf>) -> Option<u16> {
    None
}

// 상주 대기 상한 — 근거(2026-10-08 이 맥 실측, PR 본문에 원자료):
// · 포트가 아직 닫힘(앱 시작부터 잰다): 재시동 뒤 앱은 17:18:19.79에 열렸고, 상주 첫 실행은 앱 시작 약 15초 뒤 listen에
//   닿았다(첫 종료 17:18:35.298, err 로그는 EADDRINUSE 반복). 첫 실행이 죽으면 plist ThrottleInterval 10초 뒤 다시 떠
//   약 26초에 listen한다 → 30초.
// · 포트는 열렸는데 답이 없음(next start 준비 중 — Silent를 처음 본 시각부터 잰다): ~/Library/Logs/argo.log 'Ready in'
//   22건 중 최대 37.2초(나머지 21건은 1.8초 이하). 'Ready in'은 start-server.js를 읽은 순간(listen 전)부터 재므로
//   listen 뒤 준비 시간은 이보다 짧다 → 60초. 닫힘 구간이 끝나야(30초 전) Silent가 시작되므로 대기는 최대 90초다.
const RESIDENT_WAIT_CLOSED: Duration = Duration::from_secs(30);
const RESIDENT_WAIT_READY: Duration = Duration::from_secs(60);
// 확인 간격 — 루프백 연결 몇 개뿐이다(닫힌 포트는 즉시 거절, 답 없는 포트는 probe가 읽기 상한 800ms만큼 기다린다).
// 상주가 준비되면 boot.js가 스스로 프로브해 이동하므로, 이 간격은 '다른 버전으로 판명'·'포기' 판정 지연에만 든다.
pub const RESIDENT_POLL: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boot {
    Adopt(u16),
    Spawn(SpawnPlan),
}

// 앱 서버를 띄울 계획. keep_free = 상주 자리 — 상주가 늦게 뜨거나 잠깐 내려가도(재배포·재시작) 포트를 잃지 않게
// 앱 서버는 다른 포트에 띄운다. 필드가 비공개라 lib.rs는 BootPlanner가 준 계획을 그대로 쓸 수밖에 없다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpawnPlan { keep_free: Option<u16> }

impl SpawnPlan {
    pub fn keep_free(&self) -> Option<u16> { self.keep_free }

    // 띄울 포트 — 첫 스폰(tried 빈 목록)과 즉사 폴백 루프가 같이 쓴다. 상주 자리는 비워 두되, 그 자리밖에 남지 않았으면
    // 앱이 아예 못 뜨는 것보다 나으므로 마지막에 쓴다.
    pub fn port(&self, tried: &[u16], open: impl Fn(u16) -> bool, bindable: impl Fn(u16) -> bool) -> Option<u16> {
        let avoid: Vec<u16> = tried.iter().copied().chain(self.keep_free).collect();
        pick_spawn_port(&avoid, &open, &bindable).or_else(|| pick_spawn_port(tried, &open, &bindable))
    }
}

// 포트 결정 — 상주 설치 여부와, 상주 포트가 답 없이 붙잡고 있는 구간을 처음 본 시각을 들고 간다.
pub struct BootPlanner { resident: Option<u16>, silent_since: Option<Duration> }

impl BootPlanner {
    // 셸 setup이 부르는 유일한 입구 — 상주 설치 판정을 여기서 읽어, 호출하는 쪽이 상주를 빠뜨릴 자리가 없다.
    pub fn for_home(home: Option<PathBuf>) -> Self {
        BootPlanner { resident: installed_resident_port(home), silent_since: None }
    }

    // now = 부팅 시작부터 흐른 시간. None = 상주를 더 기다린다. 판정 함수를 주입받아 실소켓 없이 단위 테스트한다.
    // ① 후보 중 같은 버전 Argo가 있으면 붙는다(기존). ② 상주가 후보 포트에 설치돼 있으면 앱 서버는 그 자리를 비워 둔다.
    //   그 포트가 닫혀 있으면(아직 안 뜸) 앱 시작부터 30초, 답이 없으면(준비 중) 그 상태를 처음 본 때부터 60초까지 기다린다.
    //   답이 왔는데 같은 버전이 아니면(다른 버전 상주·타 앱) 기다리지 않고 공존한다 — 열린 포트는 SpawnPlan이 건너뛴다.
    // ③ 상주가 없으면(dmg 일반 사용자·Windows·후보 밖 포트) 지금과 같다 — 기다림 0, 3001부터.
    pub fn step(&mut self, now: Duration, probe: impl Fn(u16) -> PortState) -> Option<Boot> {
        let states: Vec<(u16, PortState)> = PORTS.iter().map(|&p| (p, probe(p))).collect();
        if let Some(&(p, _)) = states.iter().find(|(_, s)| *s == PortState::SameArgo) {
            return Some(Boot::Adopt(p));
        }
        let Some((r, state)) = self.resident.and_then(|r| states.iter().copied().find(|&(p, _)| p == r)) else {
            return Some(Boot::Spawn(SpawnPlan { keep_free: None }));
        };
        // 답 없는 구간은 이어지는 동안만 센다 — 닫혔다 다시 열리면(첫 실행이 죽고 launchd가 다시 띄움) 새 기동이다.
        self.silent_since = if state == PortState::Silent { Some(self.silent_since.unwrap_or(now)) } else { None };
        let wait = match (state, self.silent_since) {
            (PortState::Closed, _) => now < RESIDENT_WAIT_CLOSED,
            (PortState::Silent, Some(since)) => now.saturating_sub(since) < RESIDENT_WAIT_READY,
            _ => false,
        };
        if wait { None } else { Some(Boot::Spawn(SpawnPlan { keep_free: Some(r) })) }
    }

    // 상주 대기 루프 — elapsed = 부팅 시작부터 흐른 시간, pause = 상태 알림 + 한 간격 쉬기(테스트는 가짜 시계).
    pub fn settle(mut self, probe: impl Fn(u16) -> PortState, elapsed: impl Fn() -> Duration, mut pause: impl FnMut()) -> Boot {
        loop {
            if let Some(boot) = self.step(elapsed(), &probe) { return boot; }
            pause();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::PortState::{Closed, Other, SameArgo, Silent};
    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn adoption_rejects_same_version_without_current_dock_protocol() {
        for (protocol, expected) in [("", false), (",\"dockProtocol\":0", false), (",\"dockProtocol\":10", false), (",\"dockProtocol\":1", true)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let body = format!("{{\"argo\":true,\"version\":\"{}\"{protocol}}}", env!("CARGO_PKG_VERSION"));
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = [0; 512];
                let _ = socket.read(&mut request);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).unwrap();
            });
            assert_eq!(is_same_version_argo(port), expected);
            server.join().unwrap();
        }
    }

    // can_bind — 점유 포트에서 false, 해제 후 true (Hyper-V 예약 대역은 CI/mac에서 재현 불가 —
    // 그 케이스는 Windows 커널이 EACCES를 주므로 같은 is_ok() 판정으로 걸러진다. 신고 2026-07-27)
    #[test]
    fn pick_spawn_port_skips_tried_open_and_unbindable() {
        // 3001 예약(bind 불가)·3011 tried → 3021 (신고 시나리오의 폴백 경로)
        assert_eq!(pick_spawn_port(&[3011], |_| false, |p| p != 3001), Some(3021));
        // 열려 있는 포트(타 앱·타 버전 Argo)는 스폰 후보가 아니다
        assert_eq!(pick_spawn_port(&[], |p| p == 3001, |_| true), Some(3011));
        // 전부 소진 → None (무한 루프 없음)
        assert_eq!(pick_spawn_port(&[3001, 3011, 3021], |_| false, |_| true), None);
        // 전부 bind 불가(Hyper-V 대역이 3000번대 전체를 덮은 경우) → None
        assert_eq!(pick_spawn_port(&[], |_| false, |_| false), None);
    }

    #[test]
    fn can_bind_detects_occupied_and_freed_port() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(!can_bind(port), "LISTEN 중인 포트는 bind 불가여야 한다");
        drop(l);
        assert!(can_bind(port), "해제된 포트는 bind 가능해야 한다");
    }

    // ── 상주 대기(2026-10-08 실사고: 재시동 직후 앱이 3001을 먼저 차지 → 상주 2시간 50분 EADDRINUSE) ──

    fn planner(resident: Option<u16>) -> BootPlanner { BootPlanner { resident, silent_since: None } }
    fn spawn(keep_free: Option<u16>) -> Boot { Boot::Spawn(SpawnPlan { keep_free }) }

    /// 가짜 시계로 settle을 돌린다 — state_at(경과, 포트)가 그 순간 포트 상태. (결정, 결정 시각, 쉰 횟수)
    fn settle_with(resident: Option<u16>, state_at: impl Fn(Duration, u16) -> PortState) -> (Boot, Duration, u32) {
        let now = std::cell::Cell::new(Duration::ZERO);
        let pauses = std::cell::Cell::new(0u32);
        let boot = planner(resident).settle(|p| state_at(now.get(), p), || now.get(), || {
            pauses.set(pauses.get() + 1);
            now.set(now.get() + RESIDENT_POLL);
            assert!(now.get() < 300 * SECOND, "대기가 끝나지 않는다");
        });
        (boot, now.get(), pauses.get())
    }
    fn only(port: u16, state: PortState) -> impl Fn(u16) -> PortState {
        move |p| if p == port { state } else { Closed }
    }
    /// 상주 포트(3001)의 시간표 — [(이 시각부터, 상태)] 순서대로. 다른 후보는 닫힘.
    fn timeline(spans: &'static [(u64, PortState)]) -> impl Fn(Duration, u16) -> PortState {
        move |t, p| {
            if p != 3001 { return Closed; }
            spans.iter().rev().find(|(from, _)| t >= Duration::from_millis(*from)).map_or(Closed, |&(_, s)| s)
        }
    }

    #[test]
    fn resident_up_same_version_is_adopted_without_waiting() {
        let (boot, at, pauses) = settle_with(Some(3001), |_, p| only(3001, SameArgo)(p));
        assert_eq!((boot, at, pauses), (Boot::Adopt(3001), Duration::ZERO, 0));
    }

    #[test]
    fn resident_still_starting_is_waited_for_then_adopted() {
        // 이번 사고 경로: 포트 닫힘 16초(launchd 기동 지연) → 답 없음 37.2초(next 준비 최대 실측) → 같은 버전 응답.
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (16_000, Silent), (53_200, SameArgo)]));
        let ready = Duration::from_millis(53_200);
        assert_eq!(boot, Boot::Adopt(3001), "구 코드는 t=0에 3001로 스폰했다(사고 경로)");
        assert!(at >= ready && at < ready + RESIDENT_POLL, "준비된 다음 간격에 붙는다: {at:?}");
    }

    #[test]
    fn resident_relaunched_after_first_run_dies_is_still_adopted() {
        // 1차 검수 재현: 첫 실행이 즉사 → ThrottleInterval 10초 뒤 재기동이 26초에 listen → 37.2초 준비 → 63.2초 응답.
        // 답 없음 상한을 앱 시작부터 재면(60초) 여기서 폴백해 앱이 자기 서버를 띄웠다.
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (26_000, Silent), (63_200, SameArgo)]));
        assert_eq!(boot, Boot::Adopt(3001), "{at:?}");
        // 첫 실행이 listen 뒤 준비 중에 죽고(닫힘) 다시 뜨면 답 없음 구간을 새로 센다 — 처음 본 답 없음(2초)부터 재면 62초에 포기한다.
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (2_000, Silent), (25_000, Closed), (26_000, Silent), (63_200, SameArgo)]));
        assert_eq!(boot, Boot::Adopt(3001), "{at:?}");
    }

    #[test]
    fn resident_never_binding_gives_up_after_closed_limit_and_keeps_its_port_free() {
        let (boot, at, _) = settle_with(Some(3001), |_, _| Closed);
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at >= RESIDENT_WAIT_CLOSED && at < RESIDENT_WAIT_CLOSED + RESIDENT_POLL, "{at:?}");
        let Boot::Spawn(plan) = boot else { unreachable!() };
        assert_eq!(plan.port(&[], |_| false, |_| true), Some(3011), "상주 자리 3001은 비워 둔다");
    }

    #[test]
    fn resident_bound_but_silent_is_waited_up_to_ready_limit_from_first_silence() {
        let (boot, at, _) = settle_with(Some(3001), |_, p| only(3001, Silent)(p));
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at >= RESIDENT_WAIT_READY && at < RESIDENT_WAIT_READY + RESIDENT_POLL, "{at:?}");
        // 답 없음을 10초에 처음 봤으면 그때부터 60초.
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (10_000, Silent)]));
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at >= 10 * SECOND + RESIDENT_WAIT_READY && at < 10 * SECOND + RESIDENT_WAIT_READY + RESIDENT_POLL, "{at:?}");
        // 준비 중에 죽어 닫힘 상한(30초)이 지난 뒤 다시 닫히면 바로 포기한다.
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (10_000, Silent), (40_000, Closed)]));
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at >= 40 * SECOND && at < 40 * SECOND + RESIDENT_POLL, "{at:?}");
    }

    #[test]
    fn resident_wait_is_bounded_by_closed_plus_ready_limits() {
        // 상한 끝까지 버티는 모양(닫힘 상한 직전에 열리고 계속 답 없음)과, 닫힘·답 없음이 뒤섞이는 모양 — 어느 쪽도 90초를 넘지 않는다.
        let worst = RESIDENT_WAIT_CLOSED + RESIDENT_WAIT_READY;
        let (boot, at, _) = settle_with(Some(3001), timeline(&[(0, Closed), (29_500, Silent)]));
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at <= worst, "{at:?}");
        let (boot, at, _) = settle_with(Some(3001), |t, p| {
            if p != 3001 { Closed } else if (t.as_millis() / 5_000) % 2 == 0 { Closed } else { Silent }
        });
        assert_eq!(boot, spawn(Some(3001)));
        assert!(at <= worst, "{at:?}");
    }

    #[test]
    fn resident_other_version_coexists_without_waiting_but_keeps_its_port() {
        let (boot, at, pauses) = settle_with(Some(3001), |_, p| only(3001, Other)(p));
        assert_eq!((boot, at, pauses), (spawn(Some(3001)), Duration::ZERO, 0));
        let Boot::Spawn(plan) = boot else { unreachable!() };
        assert_eq!(plan.port(&[], |p| p == 3001, |_| true), Some(3011), "열린 3001(다른 버전 상주)은 건너뛴다");
        // 앱 서버가 3011에서 즉사한 순간 다른 버전 상주가 재시작 중이라 3001이 닫혀 있어도 그 자리를 잡지 않는다.
        assert_eq!(plan.port(&[3011], |_| false, |_| true), Some(3021));
    }

    #[test]
    fn resident_installed_but_another_candidate_has_same_version_is_adopted() {
        // 상주 포트가 아직 닫혀 있어도 다른 후보에 같은 버전 Argo가 이미 있으면 기다리지 않고 붙는다(기존 입양 규칙이 먼저).
        let (boot, at, pauses) = settle_with(Some(3001), |_, p| only(3011, SameArgo)(p));
        assert_eq!((boot, at, pauses), (Boot::Adopt(3011), Duration::ZERO, 0));
    }

    #[test]
    fn no_resident_is_unchanged_no_wait_and_3001_first() {
        for state in [Closed, Silent, Other] {
            let (boot, at, pauses) = settle_with(None, |_, p| only(3001, state)(p));
            assert_eq!((boot, at, pauses), (spawn(None), Duration::ZERO, 0), "{state:?}");
        }
        let Boot::Spawn(plan) = spawn(None) else { unreachable!() };
        assert_eq!(plan.port(&[], |_| false, |_| true), Some(3001));
        // 같은 버전 Argo가 다른 후보에 있으면 지금처럼 그 포트에 붙는다.
        assert_eq!(planner(None).step(Duration::ZERO, only(3011, SameArgo)), Some(Boot::Adopt(3011)));
    }

    #[test]
    fn resident_outside_candidate_ports_does_not_wait() {
        // service.mjs 기본 포트(3999)는 앱 후보와 겹치지 않는다 — 다툴 자리가 없으니 기다리지 않는다.
        let (boot, _, pauses) = settle_with(Some(3999), |_, _| Closed);
        assert_eq!((boot, pauses), (spawn(None), 0));
    }

    #[test]
    fn all_ports_taken_still_reports_no_port() {
        let (boot, _, pauses) = settle_with(Some(3001), |_, _| Other);
        assert_eq!((boot, pauses), (spawn(Some(3001)), 0));
        let Boot::Spawn(plan) = boot else { unreachable!() };
        assert_eq!(plan.port(&[], |_| true, |_| true), None, "→ 'all taken' 종결 에러(기존)");
    }

    #[test]
    fn resident_port_is_last_resort_when_nothing_else_is_usable() {
        let Boot::Spawn(plan) = spawn(Some(3001)) else { unreachable!() };
        assert_eq!(plan.port(&[], |p| p != 3001, |_| true), Some(3001), "못 뜨는 것보다 상주 자리라도 쓴다");
        // 즉사 폴백 루프도 상주 자리를 맨 뒤로 미룬다.
        assert_eq!(plan.port(&[3011], |_| false, |_| true), Some(3021));
        assert_eq!(plan.port(&[3011, 3021], |_| false, |_| true), Some(3001));
        assert_eq!(plan.port(&[3001, 3011, 3021], |_| false, |_| true), None);
    }

    // scripts/service.mjs darwinInstall이 쓰는 plist 모양 그대로.
    fn service_plist(args: &str) -> String {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>com.beyondworks.argo</string>\n  <key>ProgramArguments</key><array>\n    {args}\n  </array>\n  <key>EnvironmentVariables</key><dict>\n    <key>PORT</key><string>4444</string>\n  </dict>\n</dict></plist>\n")
    }

    #[test]
    fn resident_port_is_read_from_launch_agent_arguments() {
        let next = "<string>/usr/local/bin/node</string><string>/x/node_modules/next/dist/bin/next</string><string>start</string><string>-H</string><string>127.0.0.1</string>";
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string><string>3001</string>"))), Some(3001));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string><string>3999</string>"))), Some(3999));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>--port=3011</string>"))), Some(3011));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>--port</string><string>3021</string>"))), Some(3021));
        assert_eq!(resident_port_from_plist(&service_plist(next)), None, "-p 없음(EnvironmentVariables는 인자가 아니다)");
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string>"))), None);
        assert_eq!(resident_port_from_plist("<plist><dict></dict></plist>"), None);
    }

    #[test]
    fn planner_for_home_reads_the_installed_resident_then_waits_and_keeps_its_port() {
        // setup이 부르는 입구(for_home) 그대로 — 상주 판정이 결정까지 이어지는지(맥) / 판정하지 않는지(Windows·Linux).
        let home = std::env::temp_dir().join(format!("argo-resident-home-{}", std::process::id()));
        let agents = home.join("Library/LaunchAgents");
        std::fs::create_dir_all(&agents).unwrap();
        let closed = |_: u16| Closed;
        let without = BootPlanner::for_home(Some(home.clone())).step(Duration::ZERO, closed);
        std::fs::write(agents.join("com.beyondworks.argo.plist"), service_plist("<string>next</string><string>start</string><string>-p</string><string>3001</string>")).unwrap();
        let mut with = BootPlanner::for_home(Some(home.clone()));
        let first = with.step(Duration::ZERO, closed);
        let given_up = with.step(RESIDENT_WAIT_CLOSED, closed);
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(without, Some(spawn(None)), "plist 없음 = 상주 미설치: 기다림 0, 3001부터");
        if cfg!(target_os = "macos") {
            assert_eq!(first, None, "상주 설치 + 3001 닫힘 = 기다린다");
            assert_eq!(given_up, Some(spawn(Some(3001))), "포기해도 상주 자리는 비워 둔다");
        } else {
            assert_eq!((first, given_up), (Some(spawn(None)), Some(spawn(None))), "Windows·Linux는 판정하지 않는다(기존 동작)");
        }
        assert_eq!(BootPlanner::for_home(None).step(Duration::ZERO, closed), Some(spawn(None)));
    }

    #[test]
    fn ping_body_classification() {
        let v = env!("CARGO_PKG_VERSION");
        assert_eq!(classify_ping(&format!("{{\"argo\":true,\"version\":\"{v}\",\"dockProtocol\":1}}")), SameArgo);
        assert_eq!(classify_ping("{\"argo\":true,\"version\":\"0.0.0-other\",\"dockProtocol\":1}"), Other);
        assert_eq!(classify_ping("HTTP/1.1 404 Not Found\r\n\r\nCannot GET /api/ping"), Other);
        assert_eq!(classify_ping(""), Other);
    }

    #[test]
    fn probe_tells_closed_silent_and_hang_up_apart() {
        // 닫힘 — 아무도 듣지 않는 포트
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(probe_port(port), Closed);
        // 답 없음 — 받기만 하고 응답하지 않는다(next start 준비 중과 같은 모양)
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let held = std::thread::spawn(move || { let (s, _) = l.accept().unwrap(); std::thread::sleep(Duration::from_millis(1500)); drop(s); });
        assert_eq!(probe_port(port), Silent);
        held.join().unwrap();
        // 바로 끊음 — 기동 중이 아니다(기다리지 않는다)
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let hang = std::thread::spawn(move || { let (mut s, _) = l.accept().unwrap(); let _ = s.read(&mut [0; 512]); drop(s); });
        assert_eq!(probe_port(port), Other);
        hang.join().unwrap();
    }
}
