// 데스크톱 셸 부팅 스크립트 — 실시간 단계 표시 + 진행률 + 실패 노출.
// 상주 서버 후보: 이 기기(3001) 우선, 설치기 기본(3999) 폴백. 준비되면 그리로 이동.
// Rust(lib.rs)가 emit하는 'boot'(phase/detail)와 'boot-log'(서버 로그 라인)를 수신한다.
var TARGETS = ['http://localhost:3001', 'http://localhost:3999'];
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
    setTimeout(function () { probe(0); }, 1200);
    return;
  }
  fetch(TARGETS[i] + '/login', { mode: 'no-cors' })
    .then(function () { goto(TARGETS[i]); })
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
