// 데스크톱 셸 부팅 스크립트 — 실시간 단계 표시 + 진행률 + 실패 노출.
// 상주 서버 후보: 이 기기(3001) 우선, 폴백 3011/3021(포트 선점 대비), 설치기 기본(3999).
// Rust(lib.rs)가 emit하는 'boot'(phase/detail/port)와 'boot-log'(서버 로그 라인)를 수신한다.
// 이동 전 /api/ping 신원 마커로 "진짜 Argo인가"를 확인한다 — 타 앱이 포트를 선점한 기기에서
// no-cors fetch가 아무 응답이나 성공 처리해 낯선 서버로 이동하던 실사용 사고(2026-07-20,
// Windows 설치 직후 "Cannot GET /") 방지. lib.rs의 PORTS 후보와 일치해야 한다.
var TARGETS = ['http://localhost:3001', 'http://localhost:3011', 'http://localhost:3021', 'http://localhost:3999'];
var DEMO = /[?&]demo\b/.test(location.search); // 시각 QA용 — 리다이렉트 없이 단계 순환

var statusEl = document.getElementById('status');
var fillEl = document.getElementById('fill');
var logEl = document.getElementById('logtail');
var errEl = document.getElementById('err');

var STATUS_TEXT = {
  shell: 'Preparing the app shell…',
  starting: 'Starting the local server…',
  started: 'Local server is warming up…',
  waiting: 'Waiting for the server to respond…',
  slow: 'Still working — first launch can take a couple of minutes…',
  ready: 'Ready — opening your deck…',
};
// 단계별 진행률 바닥값 — 대기 중엔 90%를 향해 천천히 기어간다
var FLOOR = { shell: 6, starting: 24, started: 52, waiting: 58, ready: 100 };

var phase = 'shell';
var progress = FLOOR.shell;
var startedAt = Date.now();
var logLines = [];

function setPhase(p) {
  if (phase === 'ready') return;
  phase = p;
  if (STATUS_TEXT[p]) statusEl.textContent = STATUS_TEXT[p];
  if (FLOOR[p] && FLOOR[p] > progress) progress = FLOOR[p];
  render();
}
function render() { fillEl.style.width = Math.min(progress, 100) + '%'; }
render();

// 진행률 크리프 + 느린 부팅 안내(15초) — 로그 테일 공개
setInterval(function () {
  if (phase === 'ready' || phase === 'error') return; // 실패도 종결 — 진행바 크리프와 'Still working' 안내를 멈춘다
  progress += (90 - progress) * 0.025;
  render();
  var elapsed = Date.now() - startedAt;
  if (elapsed > 15000) {
    if (phase === 'waiting' || phase === 'started') statusEl.textContent = STATUS_TEXT.slow;
    if (logLines.length) { logEl.hidden = false; logEl.textContent = logLines.slice(-3).join('\n'); }
  }
}, 500);

// Tauri 이벤트 — 데스크톱 셸 안에서만 존재(브라우저로 열면 폴링만 동작)
try {
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('boot', function (e) {
      var p = e.payload || {};
      // 셸이 확정한 서버 포트 — 후보 목록 맨 앞에 넣어 다음 프로브가 우선 확인(폴백 포트 스폰 대응)
      if (p.port) {
        var u = 'http://localhost:' + p.port;
        var at = TARGETS.indexOf(u);
        if (at > 0) TARGETS.splice(at, 1);
        if (at !== 0) TARGETS.unshift(u);
      }
      if (p.phase === 'error') {
        phase = 'error'; // 종결 상태 — 진행바 크리프·slow 안내 정지(위 인터벌 가드). probe/goto는 회복 대비 계속.
        errEl.hidden = false;
        errEl.textContent = 'The local server hit a problem: ' + (p.detail || 'unknown') +
          '\nStill retrying — if this screen stays for minutes, quit and reopen Argo.';
      } else if (p.phase === 'starting' || p.phase === 'started') {
        setPhase(p.phase);
      }
    });
    window.__TAURI__.event.listen('boot-log', function (e) {
      if (typeof e.payload === 'string' && e.payload) logLines.push(e.payload);
    });
  }
} catch (err) { /* 이벤트 미지원 환경 — 폴링만으로 동작 */ }

function goto(url) {
  setPhase('ready');
  progress = 100; render();
  if (DEMO) { statusEl.textContent = STATUS_TEXT.ready + ' (demo — staying here)'; return; }
  setTimeout(function () { location.replace(url); }, 350);
}

function probe(i) {
  if (phase === 'ready') return;
  if (i >= TARGETS.length) {
    if (phase === 'shell') setPhase('waiting');
    // 60초 넘게 신원 확인이 한 번도 성공하지 못하면 침묵 대기 대신 행동 안내를 띄운다
    // (재시도는 계속 — 회복 대비). 검수 LOW: 프로브 측 실패의 무한 'Still working' 방지.
    if (Date.now() - startedAt > 60000 && phase !== 'error' && errEl.hidden) {
      errEl.hidden = false;
      errEl.textContent = 'The server has not responded for a minute. Quit and reopen Argo — if it persists, another app may be using ports 3001/3011/3021.';
    }
    setTimeout(function () { probe(0); }, 1200);
    return;
  }
  var target = TARGETS[i];
  // 신원 확인 후에만 이동 — 기존 no-cors '/login' 프로브는 어떤 서버가 응답해도 성공 처리돼
  // 포트를 선점한 타 앱으로 이동했다(실사용 "Cannot GET /"). /api/ping은 CORS 개방이라 본문 판독 가능.
  fetch(target + '/api/ping', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && d.argo === true) { goto(target); } else { probe(i + 1); }
    })
    .catch(function () { probe(i + 1); });
}
if (!DEMO) probe(0);

// 데모 모드 — 단계 순환으로 시각 확인
if (DEMO) {
  var seq = ['starting', 'started', 'waiting'];
  seq.forEach(function (p, idx) { setTimeout(function () { setPhase(p); }, 1200 * (idx + 1)); });
  setTimeout(function () {
    logLines.push('[server] compiling routes…', '[server] warming cache…', '[server] listening on 3001');
  }, 2000);
}
