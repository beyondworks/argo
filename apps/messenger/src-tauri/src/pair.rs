// 로그인 브리지 — 루프백 일회용 HTTP 서버. Argo 앱 app/api/auth/pair/store.mjs + app/auth/paired/page.jsx의 셸판.
//
// 흐름: 웹뷰 pair_start → 127.0.0.1:<임의 포트>에 listen, code(브라우저용)+verifier(앱 전용) 생성 →
//   웹뷰가 브라우저에 Supabase authorize(redirect_to=http://127.0.0.1:<port>/auth/paired?pair=<code>)를 연다 →
//   Supabase가 implicit 조각(#access_token)으로 되돌리면 /auth/paired 페이지(아래 HTML)가 조각을 파싱해 사용자 승인 뒤
//   POST /api/auth/pair/bind 로 봉인 → 웹뷰가 pair_claim(code, verifier)로 1회 회수 → 세션 심고 서버 종료.
// 원칙(원본과 동일): 코드 단명(5분)·1회 소비, 토큰은 메모리에만(디스크·로그 금지), 루프백 전용, 승인 없는 drive-by 봉인 금지,
//   verifier 불일치는 존재를 숨긴다(expired). 웹뷰 밖에서 오는 요청은 code를 모르면 아무것도 못 한다.
// ponytail: 의존성 0의 손 HTTP 파서 — 요청 한 건이 8KB를 넘거나 청크 전송이면 거절한다(브라우저의 이 두 요청은 그보다 훨씬 작다).
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(5 * 60);
const MAX_REQ: usize = 8 * 1024;

struct Entry { verifier: String, session: Option<(String, String)>, created: Instant, done: bool }

// code → 항목. 서버 스레드와 invoke 핸들러가 공유한다. 앱 프로세스 생명 안에서만 산다.
static STORE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

fn rand_hex(n: usize) -> String {
    // getrandom 크레이트 없이 OS 난수 — /dev/urandom(유닉스)·BCryptGenRandom 대신 std의 RandomState 해시를 여러 번 섞는다.
    // ponytail: 암호학적 CSPRNG는 아니지만 code는 5분 단명 + verifier 별도 + 루프백 한정이라 추측 공격 창이 없다. 필요하면 getrandom으로.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(n * 2);
    let mut i = 0u64;
    while out.len() < n * 2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i); h.write_u128(Instant::now().elapsed().as_nanos() ^ (std::process::id() as u128));
        out.push_str(&format!("{:016x}", h.finish()));
        i += 1;
    }
    out.truncate(n * 2);
    out
}

fn sweep(m: &mut HashMap<String, Entry>) { m.retain(|_, e| e.created.elapsed() < TTL && !e.done); }

fn with_store<T>(f: impl FnOnce(&mut HashMap<String, Entry>) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    sweep(m);
    f(m)
}

/// 웹뷰: 서버를 띄우고 { port, code, verifier }를 돌려준다. 서버는 이 code가 소비되거나 만료되면 스스로 닫힌다.
#[tauri::command]
pub fn pair_start() -> Result<serde_json::Value, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let code = rand_hex(24);
    let verifier = rand_hex(24);
    with_store(|m| { m.insert(code.clone(), Entry { verifier: verifier.clone(), session: None, created: Instant::now(), done: false }); });
    let code_for_thread = code.clone();
    std::thread::spawn(move || serve(listener, code_for_thread));
    Ok(serde_json::json!({ "port": port, "code": code, "verifier": verifier }))
}

/// 웹뷰: verifier로 1회 회수. pending / ready{access_token, refresh_token} / expired.
#[tauri::command]
pub fn pair_claim(code: String, verifier: String) -> serde_json::Value {
    with_store(|m| match m.get_mut(&code) {
        Some(e) if e.verifier == verifier => match e.session.take() {
            Some((a, r)) => { e.done = true; serde_json::json!({ "status": "ready", "access_token": a, "refresh_token": r }) }
            None => serde_json::json!({ "status": "pending" }),
        },
        _ => serde_json::json!({ "status": "expired" }),
    })
}

fn serve(listener: TcpListener, code: String) {
    let _ = listener.set_nonblocking(true);
    let deadline = Instant::now() + TTL;
    while Instant::now() < deadline {
        // code가 소비됐으면(회수 완료) 서버도 끝 — 포트를 오래 열어 두지 않는다.
        if with_store(|m| m.get(&code).map(|e| e.done).unwrap_or(true)) { return; }
        match listener.accept() {
            Ok((s, _)) => { let c = code.clone(); std::thread::spawn(move || handle(s, c)); }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return,
        }
    }
}

fn handle(mut s: TcpStream, code: String) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    // 헤더 끝까지 읽고, Content-Length만큼 본문을 더 읽는다(청크 전송은 거절).
    let (head_end, headers) = loop {
        let n = match s.read(&mut tmp) { Ok(0) | Err(_) => return, Ok(n) => n };
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > MAX_REQ { let _ = respond(&mut s, 413, "text/plain", b"too large"); return; }
        if let Some(i) = find(&buf, b"\r\n\r\n") { break (i + 4, String::from_utf8_lossy(&buf[..i]).to_string()); }
    };
    let mut lines = headers.lines();
    let req = lines.next().unwrap_or("");
    let mut parts = req.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let clen: usize = lines.filter_map(|l| l.split_once(':')).find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse().ok()).unwrap_or(0);
    if clen > MAX_REQ { let _ = respond(&mut s, 413, "text/plain", b"too large"); return; }
    while buf.len() < head_end + clen {
        let n = match s.read(&mut tmp) { Ok(0) | Err(_) => return, Ok(n) => n };
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = &buf[head_end..head_end + clen];
    let path = target.split('?').next().unwrap_or("");
    match (method, path) {
        ("GET", "/auth/paired") => { let _ = respond(&mut s, 200, "text/html; charset=utf-8", PAIRED_HTML.as_bytes()); }
        ("POST", "/api/auth/pair/bind") => {
            // 조각 파싱은 브라우저 페이지가 했고, 여기엔 code+토큰만 온다. code가 맞고 아직 미봉인일 때만.
            let v: serde_json::Value = match serde_json::from_slice(body) { Ok(v) => v, Err(_) => { let _ = respond(&mut s, 400, "application/json", br#"{"ok":false}"#); return; } };
            let got = (v.get("code").and_then(|x| x.as_str()), v.get("access_token").and_then(|x| x.as_str()), v.get("refresh_token").and_then(|x| x.as_str()));
            let ok = match got {
                (Some(c), Some(a), Some(r)) if c == code && !a.is_empty() && !r.is_empty() => with_store(|m| match m.get_mut(c) {
                    Some(e) if e.session.is_none() => { e.session = Some((a.to_string(), r.to_string())); true }
                    _ => false,
                }),
                _ => false,
            };
            let _ = respond(&mut s, 200, "application/json", if ok { br#"{"ok":true}"# } else { br#"{"ok":false}"# });
        }
        _ => { let _ = respond(&mut s, 404, "text/plain", b"not found"); }
    }
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> { h.windows(n.len()).position(|w| w == n) }

fn respond(s: &mut TcpStream, status: u16, ctype: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 413 => "Payload Too Large", _ => "OK" };
    // 캐시 금지 + 동일 출처 외 스크립트 로드 없음(인라인만) — 토큰이 URL 조각으로 오므로 페이지가 절대 외부로 새지 않게.
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

// 착지 페이지 — Argo 앱 app/auth/paired/page.jsx와 같은 단계(checking → confirm → done/error). 조각(#access_token…)을 파싱해
// 사용자가 "이 기기 로그인"을 눌렀을 때만 봉인한다(drive-by 차단). 룩은 메신저 linen 토큰 최소값을 인라인으로.
const PAIRED_HTML: &str = r##"<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Argo Messenger</title>
<style>
:root{--bg:#e9e6df;--card:#fbfaf7;--fg:#26241f;--fg2:#5a564d;--primary:#1f1e1b;--pfg:#f4f2ec;--mark:#e8e400;--border:#d9d5cc;--danger:#a23b2a}
@media(prefers-color-scheme:dark){:root{--bg:#1f1e1b;--card:#2a2926;--fg:#e6e2d8;--fg2:#b3ada2;--primary:#ececea;--pfg:#1f1e1b;--border:#3c3a35}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 Pretendard,-apple-system,"Segoe UI",sans-serif}
main{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(420px,100%);background:var(--card);border:1px solid var(--border);border-radius:22px;overflow:hidden}
.band{display:flex;align-items:center;gap:10px;padding:14px 20px;background:#1f1e1b;color:#e6e2d8;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em}
.band i{width:10px;height:10px;background:var(--mark);clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%)}
.body{padding:22px;display:grid;gap:12px}h1{margin:0;font-size:18px}p{margin:0;color:var(--fg2);font-size:13px}
button{height:44px;border:0;border-radius:999px;background:var(--primary);color:var(--pfg);font:600 13px inherit;cursor:pointer}
.err{color:var(--danger)}.hide{display:none}
</style></head><body><main><div class="card"><div class="band"><i></i>ARGO<span style="margin-left:auto;font-weight:500;letter-spacing:.02em;opacity:.75">팀 메신저</span></div><div class="body">
<div id="checking"><p data-ko="앱에 연결하는 중…" data-en="Connecting to the app…"></p></div>
<div id="confirm" class="hide"><h1 data-ko="이 기기를 로그인시킬까요?" data-en="Log in this device?"></h1><p data-ko="Argo Messenger에서 로그인을 시작한 게 맞을 때만 승인하세요. 앱에서 시작하지 않았다면 이 창을 닫으세요 — 승인하면 이 브라우저의 로그인이 앱으로 넘어갑니다." data-en="Approve only if you started this sign-in from Argo Messenger. If you did not, close this window — approving hands this browser's sign-in to the app."></p><button id="ok" data-ko="이 기기 로그인" data-en="Log in this device"></button></div>
<div id="done" class="hide"><h1 data-ko="로그인 완료" data-en="Signed in"></h1><p data-ko="앱으로 돌아가세요. 이 창은 닫아도 됩니다." data-en="Return to the app. You can close this window."></p></div>
<div id="error" class="hide"><h1 class="err" data-ko="연결하지 못했습니다" data-en="Could not connect"></h1><p data-ko="앱에서 다시 시도해 주세요." data-en="Please try again from the app."></p></div>
</div></div></main>
<script>
(function(){
  var en=/^en/i.test(navigator.language||'');document.querySelectorAll('[data-ko]').forEach(function(el){el.textContent=el.getAttribute(en?'data-en':'data-ko');});
  function show(id){['checking','confirm','done','error'].forEach(function(k){document.getElementById(k).classList.toggle('hide',k!==id);});}
  var q=new URLSearchParams(location.search),pair=q.get('pair');
  var h=new URLSearchParams((location.hash||'').replace(/^#/,''));
  var at=h.get('access_token'),rt=h.get('refresh_token');
  history.replaceState(null,'',location.pathname+location.search); // 조각(토큰) URL에서 제거
  if(!pair||!at||!rt){show('error');return;}
  show('confirm');
  document.getElementById('ok').onclick=function(){
    show('checking');
    fetch('/api/auth/pair/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:pair,access_token:at,refresh_token:rt})})
      .then(function(r){return r.json();}).then(function(j){show(j&&j.ok?'done':'error');if(j&&j.ok){setTimeout(function(){window.close();},1200);}})
      .catch(function(){show('error');});
    at=rt=null;
  };
})();
</script></body></html>"##;
