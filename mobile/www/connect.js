// 연결 화면 — 이 앱의 유일한 자체 화면. 저장된 PC 주소가 응답하면 그 오리진으로 WebView를 옮기고(이후는 PC가
// 그리는 아르고 화면 그대로), 없거나 응답이 없으면 QR 스캔·수동 입력으로 페어링 페이지(/m/pair?c=)를 연다.
// 페어링 쿠키는 그 오리진에 남으므로 다음 실행부터는 바로 홈으로 간다. 앱 자체는 어떤 데이터도 갖지 않는다.
// ponytail: '다른 PC로 바꾸기'는 기존 PC가 응답하지 않을 때만 이 화면이 다시 뜨는 것으로 대신한다 — PC 오리진
//           페이지에서 capacitor:// 오리진으로 되돌아오는 경로가 없어서다. 필요해지면 App 플러그인 딥링크로.
(async () => {
  const KEY = 'argo-pc'; // 마지막으로 연결된 PC의 origin (http://host:port)
  const LANG = (navigator.language || 'ko').startsWith('ko') ? 'ko' : 'en';
  const T = {
    ko: { title: 'PC의 아르고에 연결', help: 'PC 설정 → 휴대폰에서 열기의 QR을 비추거나, 주소와 코드를 입력하세요.', scan: 'QR 스캔', or: '또는 직접 입력', connect: '연결', probing: 'PC를 찾는 중…', last: '마지막 연결: {h}', unreachable: 'PC에 연결할 수 없습니다 — PC가 켜져 있고 같은 네트워크(또는 Tailscale)에 있는지 확인하세요.', badQr: 'QR이 아르고 페어링 코드가 아닙니다.', need: '주소와 코드를 입력하세요.', notPrivate: '집·사무실 네트워크(또는 Tailscale) 주소만 자동 연결합니다. 주소를 확인하고 직접 연결을 누르세요.' },
    en: { title: 'Connect to Argo on your PC', help: 'Scan the QR under PC settings → Open on your phone, or enter the address and code.', scan: 'Scan QR', or: 'or enter manually', connect: 'Connect', probing: 'Looking for your PC…', last: 'Last connected: {h}', unreachable: "Can't reach the PC — make sure it's on and on the same network (or Tailscale).", badQr: 'That QR is not an Argo pairing code.', need: 'Enter the address and code.', notPrivate: 'Only home/office network (or Tailscale) addresses connect automatically. Check the address and tap Connect.' },
  }[LANG];
  const t = (k, v = {}) => T[k].replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  // 네이티브 런타임 전역엔 registerPlugin이 없고 Capacitor.Plugins에 네이티브 플러그인 프록시가 있다(Android CDP 실측 2026-09-03).
  const plugin = (name) => window.Capacitor?.registerPlugin?.(name) ?? window.Capacitor?.Plugins?.[name] ?? null;
  // QR·딥링크로 들어오는 주소는 사설망·Tailscale·로컬 테스트 도메인만 받는다 — 임의 인터넷 오리진으로 앱을 재지정하는
  // 피싱 면 차단(분리 검수 M1·H1과 같은 허용 범위 = capacitor.config.json allowNavigation). 수동 입력은 사용자 의도라 제한 없음.
  const privateHost = (origin) => { try { const h = new URL(origin).hostname; return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(h) || /\.ts\.net$/.test(h) || h === '127.0.0.1.nip.io'; } catch { return false; } };

  const $ = (id) => document.getElementById(id);
  const show = (id, on) => { $(id).hidden = !on; };
  const err = (m) => { $('err').textContent = m || ''; show('err', !!m); };
  const normOrigin = (s) => {
    let v = String(s || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;
    try { const u = new URL(v); return `${u.protocol}//${u.host}`; } catch { return ''; }
  };
  const ping = async (origin, ms = 3000) => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(`${origin}/api/ping`, { signal: ctl.signal, cache: 'no-store' }); const j = await r.json(); return !!j.argo; }
    catch { return false; } finally { clearTimeout(tm); }
  };
  const go = (url) => { window.location.replace(url); };

  function connectScreen() {
    show('boot', false); show('connect', true);
    const last = localStorage.getItem(KEY);
    if (last) { $('addr').value = last.replace(/^https?:\/\//, ''); $('last').textContent = t('last', { h: last.replace(/^https?:\/\//, '') }); show('last', true); }
  }

  async function pair(origin, code) {
    err('');
    if (!origin || !code) return err(t('need'));
    $('go').disabled = true;
    if (!(await ping(origin))) { $('go').disabled = false; return err(t('unreachable')); }
    localStorage.setItem(KEY, origin);
    go(`${origin}/m/pair?c=${encodeURIComponent(code.trim().toUpperCase())}`);
  }

  $('go').addEventListener('click', () => pair(normOrigin($('addr').value), $('code').value));
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

  // QR — Capacitor 네이티브 스캐너(@capacitor/barcode-scanner). 번들러 없이 registerPlugin 프록시로 호출한다.
  $('scan').addEventListener('click', async () => {
    err('');
    try {
      const Scanner = plugin('CapacitorBarcodeScanner');
      if (!Scanner) throw new Error('no-scanner');
      const r = await Scanner.scanBarcode({ hint: 0, scanInstructions: t('help'), cameraDirection: 1 });
      const m = String(r?.ScanResult || '').match(/^(https?:\/\/[^/]+)\/m\/pair\?c=([A-Za-z0-9]+)/);
      if (!m) return err(t('badQr'));
      $('addr').value = m[1].replace(/^https?:\/\//, ''); $('code').value = m[2];
      if (!privateHost(m[1])) return err(t('notPrivate'));
      await pair(m[1], m[2]);
    } catch (e) {
      if (String(e?.message || e).includes('no-scanner')) { show('scan', false); return; } // 웹 브라우저 등 — 수동 입력만
      err(String(e?.message || e));
    }
  });

  // 딥링크 argo://pair?u=<origin>&c=<code> — 링크 탭·헤드리스 검증 진입로. **프리필까지만** 하고 연결은 사용자 탭으로
  // (어떤 앱이든 이 링크를 열 수 있어 자동 연결은 앱을 공격자 서버로 재지정하는 피싱 면 — 분리 검수 M1). 사설 범위
  // 밖 주소는 안내만. 콜드 스타트는 getLaunchUrl, 실행 중엔 appUrlOpen. Android 뒤로가기는 WebView 히스토리로.
  const fromDeepLink = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'argo:' || u.hostname !== 'pair') return false;
      const origin = normOrigin(u.searchParams.get('u')), code = u.searchParams.get('c') || '';
      if (!origin || !code) return false;
      connectScreen(); // 먼저 그리고(저장된 주소로 채움) 그 위에 딥링크 값을 덮는다(검수 L4)
      $('addr').value = origin.replace(/^https?:\/\//, ''); $('code').value = code;
      err(privateHost(origin) ? '' : t('notPrivate'));
      $('go').focus();
      return true;
    } catch { return false; }
  };
  let launchedByLink = false;
  try {
    const App = plugin('App');
    App?.addListener?.('backButton', ({ canGoBack }) => { if (canGoBack) window.history.back(); else App.exitApp(); });
    App?.addListener?.('appUrlOpen', ({ url }) => fromDeepLink(url));
    if (App?.getLaunchUrl) launchedByLink = !!(await App.getLaunchUrl().then((r) => r?.url && fromDeepLink(r.url)).catch(() => false));
  } catch { /* 웹에선 없음 */ }
  if (launchedByLink) return;

  (async () => {
    const last = localStorage.getItem(KEY);
    if (last && await ping(last)) return go(`${last}/m/home`); // 서버가 첫 회사로 302(토큰 무효면 /m/pair로)
    connectScreen();
  })();
})();
