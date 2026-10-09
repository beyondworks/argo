// 데스크톱 셸 부팅 스크립트 — 실시간 단계 표시 + 진행률 + 실패 노출.
// 상주 서버 후보: 이 기기(3001) 우선, 폴백 3011/3021(포트 선점 대비), 설치기 기본(3999).
// Rust(lib.rs)가 emit하는 'boot'(phase/detail/port)와 'boot-log'(서버 로그 라인)를 수신한다.
// 이동 전 /api/ping 신원 마커로 "진짜 Argo인가"를 확인한다 — 타 앱이 포트를 선점한 기기에서
// no-cors fetch가 아무 응답이나 성공 처리해 낯선 서버로 이동하던 실사용 사고(2026-07-20,
// Windows 설치 직후 "Cannot GET /") 방지. src-tauri/src/boot_port.rs의 PORTS 후보와 일치해야 한다.
var TARGETS = ['http://localhost:3001', 'http://localhost:3011', 'http://localhost:3021', 'http://localhost:3999'];
var DEMO = /[?&]demo\b/.test(location.search); // 시각 QA용 — 리다이렉트 없이 단계 순환
// 앱(쉘) 버전 — lib.rs boot 이벤트가 실어 준다. 있으면 "같은 버전의 Argo"에만 이동한다.
// (버전 불문 이동은 v0.1.20 앱이 상주 v0.1.22 서버 화면을 띄우는 어긋남을 만들었다 — 2026-07-22 신고)
var APP_VER = null;
var FIXED_TARGET = null; // 셸이 확정한 자기 서버 — 프로브 상한을 후보(1.5s)보다 넉넉히(8s)
// 프로브 사이클(후보 목록 소진 횟수). boot 이벤트는 비동기 등록(listen)이 셸의 동기 emit보다
// 늦어 유실될 수 있다 — 그러면 FIXED_TARGET이 영영 없어서, 기동이 느린 자기 서버(ping 3s)가
// 1.5s 상한에 영구 미부착(분리 검수 실측: 20s간 abort 8회). 사이클마다 상한을 늘려
// 이벤트 도착 여부와 무관하게 느린-살아있는 서버를 굶기지 않는다(첫 사이클 신속 폴오버는 유지).
var CYCLE = 1;

var statusEl = document.getElementById('status');
var fillEl = document.getElementById('fill');
var logEl = document.getElementById('logtail');
var errEl = document.getElementById('err');
var titleEl = document.getElementById('title');
var barEl = document.getElementById('bar');

// 화면 문구 ko/en 두 벌 — 이 파일은 Next 밖의 정적 파일(Tauri frontendDist=public)이라 앱의 사전(app/i18n.jsx, React 모듈)을 쓸 수 없다.
// 새 문구를 더하면 두 언어에 같은 칸으로 더한다(test/boot-probe.test.mjs가 칸 일치·용어를 잠근다). 용어는 앱과 같다: 사용자·에이전트.
// 셸(Rust)이 보내는 원인(detail)은 번역하지 않고 그대로 붙인다.
var BOOT_TEXT = {
  en: {
    title: 'Connecting to Argo…',
    bar: 'startup progress',
    sec: 's',
    demo: ' (demo — staying here)',
    status: {
      shell: 'Preparing the app shell…',
      // 상주 서비스가 설치된 기기에서 셸이 상주가 뜨기를 기다리는 동안(boot_port.rs BootPlanner) — 그 사이에도 아래 프로브는
      // 후보 전부를 계속 확인해, 상주가 같은 버전으로 답하는 순간 그쪽으로 이동한다.
      resident: 'Waiting for the Argo background service to start…',
      starting: 'Starting the local server…',
      started: 'Local server is warming up…',
      waiting: 'Waiting for the server to respond…',
      slow: 'Still working — first launch can take a couple of minutes…',
      ready: 'Ready — opening your deck…',
    },
    errStart: 'The local server could not start: ',
    errProblem: 'The local server hit a problem: ',
    errRetry: '\nStill retrying — if this screen stays for minutes, quit and reopen Argo.',
    errUnknown: 'unknown',
    errMinute: 'The server has not responded for a minute. Quit and reopen Argo — if it persists, another app may be using ports 3001/3011/3021.',
  },
  ko: {
    title: 'Argo에 연결하는 중…',
    bar: '시작 진행률',
    sec: '초',
    demo: ' (데모 — 이 화면에 머뭅니다)',
    status: {
      shell: '앱을 준비하는 중…',
      resident: 'Argo 백그라운드 서비스가 시작되기를 기다리는 중…',
      starting: '이 컴퓨터의 서버를 시작하는 중…',
      started: '서버를 준비하는 중…',
      waiting: '서버가 응답하기를 기다리는 중…',
      slow: '아직 준비 중입니다 — 처음 실행은 몇 분 걸릴 수 있습니다…',
      ready: '준비됐습니다 — 화면을 엽니다…',
    },
    errStart: '이 컴퓨터의 서버를 시작하지 못했습니다: ',
    errProblem: '서버에 문제가 생겼습니다: ',
    errRetry: '\n계속 다시 시도하는 중입니다 — 이 화면이 몇 분 넘게 그대로면 Argo를 종료했다가 다시 여세요.',
    errUnknown: '알 수 없음',
    errMinute: '서버가 1분 넘게 응답하지 않습니다. Argo를 종료했다가 다시 여세요. 그래도 같으면 다른 앱이 3001/3011/3021 포트를 쓰고 있을 수 있습니다.',
  },
};

// 표시 언어 — ① 앱이 저장한 'argo-lang'(ko|en)이 이 화면의 출처에서 읽히면 그것 ② 웹뷰·OS 언어(ko로 시작하면 한국어, 그 밖은 영어) ③ 영어(이전과 같다).
// 주의: 이 화면은 앱 본체(http://localhost:포트)가 아니라 셸 자신의 출처에서 뜨고 웹뷰 저장소는 출처별이라, 설치본에서는 ①이 비어 ②가 정한다
// (맥 설치본 저장소 실측: argo-lang은 앱 출처에만 있다). ①이 읽히는 곳은 같은 출처로 연 경우(개발 서버의 /index.html 등)다.
// 앱에서 고른 언어를 설치본 부트 화면까지 이으려면 셸이 boot 이벤트에 언어를 실어야 한다(Rust 변경 — 이 파일 범위 밖).
function pickLang() {
  try {
    var saved = window.localStorage && window.localStorage.getItem('argo-lang');
    if (saved === 'ko' || saved === 'en') return saved;
  } catch (e) { /* 저장소 접근 불가(웹뷰 설정·프라이빗 모드) — 아래 웹뷰 언어 */ }
  try {
    var nav = typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]));
    if (nav && /^ko\b/i.test(String(nav))) return 'ko';
  } catch (e) { /* navigator 접근 불가 */ }
  return 'en';
}
var LANG = pickLang();
var TXT = BOOT_TEXT[LANG];
var STATUS_TEXT = TXT.status;
try { // HTML에 영어로 적힌 첫 화면 글자를 표시 언어로 — 요소가 없는 환경(테스트 스텁)에서도 예외 없이
  if (document.documentElement) document.documentElement.lang = LANG;
  if (titleEl) titleEl.textContent = TXT.title;
  if (barEl && barEl.setAttribute) barEl.setAttribute('aria-label', TXT.bar);
  statusEl.textContent = STATUS_TEXT.shell;
} catch (err) { /* 글자 교체 실패는 화면 진행에 영향 없다 */ }
// 단계별 진행률 바닥값 — 대기 중엔 90%를 향해 천천히 기어간다
var FLOOR = { shell: 6, resident: 14, starting: 24, started: 52, waiting: 58, ready: 100 };
// 상주 대기(최대 90초) 중에는 막대가 40%까지만 오른다 — 기다림 끝에 앱 서버를 띄울 때 실제 기동을 보여 줄 구간을 남긴다.
var CREEP_CAP = { resident: 40 };

var phase = 'shell';
var progress = FLOOR.shell;
var startedAt = Date.now();
var residentAt = 0; // 상주 대기에 들어온 시각 — 문구의 경과 초
var logLines = [];

function setPhase(p) {
  if (phase === 'ready') return;
  if (p === 'resident' && phase !== 'resident') residentAt = Date.now();
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
  var cap = CREEP_CAP[phase] || 90;
  if (progress < cap) progress += (cap - progress) * 0.025;
  render();
  // 상주 대기(최대 90초)는 막대가 waiting(58%)에 멈춰 있을 수 있고, '동작 줄이기' 설정이면 배·파도도 멈춘다 — 기다린 초로 화면이 살아 있음을 보인다(#874 2차 검수 LOW).
  if (phase === 'resident') statusEl.textContent = STATUS_TEXT.resident + ' ' + Math.floor((Date.now() - residentAt) / 1000) + TXT.sec;
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
      if (p.version) APP_VER = p.version; // 이후 프로브는 같은 버전의 Argo에만 이동
      // 셸이 확정한 서버 포트 — 그 포트로 고정(단일 교체, 원 설계 유지). 분리 검수 절제 실험
      // (2026-08-30): 영구 대기의 원인은 단일 교체가 아니라 **무타임아웃 프로브** 하나였고,
      // 앞 배치는 중복 프로브(+1.5s)와 같은 버전 상주로 새는 경로만 만들었다. 확정 포트는
      // 자기 서버라 기동 지연이 정상일 수 있어 프로브 상한을 넉넉히 준다(아래 FIXED 분기).
      if (p.port) {
        FIXED_TARGET = 'http://localhost:' + p.port;
        TARGETS = [FIXED_TARGET];
      }
      if (p.phase && p.phase !== 'error') errEl.hidden = true; // 폴백 재스폰으로 살아나면 이전 에러 배너 제거(2R H5)
      if (p.phase === 'error') {
        phase = 'error'; // 종결 상태 — 진행바 크리프·slow 안내 정지(위 인터벌 가드). probe/goto는 회복 대비 계속.
        errEl.hidden = false;
        // terminal = 셸이 후보 포트를 소진하고 재기동을 멈춘 상태 — "재시도 중"을 붙이면 거짓이 된다
        // (실사용 신고 2026-07-27: 재시도 문구는 뜨는데 실제 재시도 0회). 폴백 도중은 셸이 재스폰하므로 기존 문구 유지.
        errEl.textContent = p.terminal
          ? TXT.errStart + (p.detail || TXT.errUnknown)
          : TXT.errProblem + (p.detail || TXT.errUnknown) + TXT.errRetry;
      } else if (p.phase === 'starting' || p.phase === 'started' || p.phase === 'resident') {
        // 상주 대기(최대 90초)가 끝나면 — 앱 서버를 띄우든(starting) 상주에 붙든(started) — 느린 부팅 안내(15초)와
        // 1분 무응답 안내의 기준 시각을 다시 잡는다. 기다린 시간까지 세면 막 뜨는 서버에 그 안내가 바로 붙는다.
        if (phase === 'resident' && p.phase !== 'resident') startedAt = Date.now();
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
  if (DEMO) { statusEl.textContent = STATUS_TEXT.ready + TXT.demo; return; }
  setTimeout(function () { location.replace(url); }, 350);
}

function probe(i) {
  if (phase === 'ready') return;
  if (i >= TARGETS.length) {
    if (phase === 'shell') setPhase('waiting');
    // 60초 넘게 신원 확인이 한 번도 성공하지 못하면 침묵 대기 대신 행동 안내를 띄운다
    // (재시도는 계속 — 회복 대비). 검수 LOW: 프로브 측 실패의 무한 'Still working' 방지.
    if (Date.now() - startedAt > 60000 && phase !== 'error' && phase !== 'resident' && errEl.hidden) {
      errEl.hidden = false;
      errEl.textContent = TXT.errMinute;
    }
    CYCLE += 1; // 소진 1회 = 사이클 종료 — 다음 바퀴는 후보 상한을 늘려 준다(위 CYCLE 주석)
    setTimeout(function () { probe(0); }, 1200);
    return;
  }
  var target = TARGETS[i];
  // 신원 확인 후에만 이동 — 기존 no-cors '/login' 프로브는 어떤 서버가 응답해도 성공 처리돼
  // 포트를 선점한 타 앱으로 이동했다(실사용 "Cannot GET /"). /api/ping은 CORS 개방이라 본문 판독 가능.
  // 프로브당 상한 — 연결만 받고 응답을 끄는 선점 프로세스에서 fetch가 무기한 매달리면
  // 다음 후보(폴백 스폰 3011)로 영영 못 넘어간다(윈도 실기기 2026-08-30: 검수 재현에서 425s+
  // 회복 없음 = 영구). 단 **자기 서버(확정 포트)는 기동 중 지속 지연이 정상**일 수 있어(느린
  // 기기+AV+이벤트 루프 점유 — 검수 실측: 일괄 1.5s는 ping 3s 서버에 영구 미부착 회귀) 8s.
  var limitMs = FIXED_TARGET && target === FIXED_TARGET ? 8000 : Math.min(1500 * CYCLE, 8000);
  var ac = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ac ? setTimeout(function () { ac.abort(); }, limitMs) : null;
  fetch(target + '/api/ping', ac ? { cache: 'no-store', signal: ac.signal } : { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (timer) clearTimeout(timer);
      // 신원 + (셸 버전을 아는 경우) 버전까지 일치해야 이동 — 다른 버전의 Argo는 건너뛴다
      // Even if the native boot event was lost, never adopt a same-version
      // resident that predates the Dock fixes. A new shell cannot patch its env.
      if (d && d.argo === true && d.dockProtocol === 1 && (!APP_VER || d.version === APP_VER)) { goto(target); } else { probe(i + 1); }
    })
    .catch(function () { if (timer) clearTimeout(timer); probe(i + 1); });
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
