import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, applyShell, readTheme, readShell } from './core/theme.js';
import { getLang } from './core/i18n.js';
import { initSession } from './core/session.js';
import { isDesktop } from './core/platform.js';
import './tokens.css';
import './base.css';
import './themes.css'; // 앱 셸 × 새 다섯 색 — base.css 뒤에 둔다(같은 토큰을 덮어쓴다)

applyTheme(readTheme());
applyShell(readShell());
document.documentElement.lang = getLang();
// 메일 연결 복귀·데스크톱 딥링크 코드는 그 경우에만 받는다(첫 화면 150KB 상한, bundle.md ②). 보낼 목록의 서버 전송은 처음 보낼 때 받는다(sync.js, ⑤)
const desktopAuth = () => import('./core/desktop-auth.js');
// 데스크톱 넘김 코드를 못 받거나 넘기기가 실패해도 화면은 그린다 — 웹 메일 연결 복귀 화면(/me/mail/connect)이 하얗게 남지 않게(분리 검수 의심 2)
const mailRelay = () => desktopAuth().then((m) => m.initMailRelay()).catch((e) => { console.warn('[office] mail relay failed', e?.message); return false; });
// 보낼 목록의 서버 전송 코드(sync.js가 처음 보낼 때 받는 것)를 앱을 그린 뒤 한가할 때 미리 받아 둔다. 처음 보낼 때 받으면 그때 오프라인이면
// 브라우저가 실패한 불러오기를 기억해 새로고침 전까지 저장이 계속 실패할 수 있다(분리 검수 의심 1). 따로 나뉜 묶음이라 첫 화면 크기에는 들어가지 않는다
const warmTransport = () => (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(() => { import('./core/transport.js').catch(() => {}); });
async function boot() {
  if (!isDesktop() && location.pathname === '/me/mail/connect' && (await mailRelay())) return;
  createRoot(document.getElementById('root')).render(<App />);
  warmTransport();
  await initSession();
  if (isDesktop()) await (await desktopAuth()).initDesktopAuth();
}
boot().catch((e) => console.warn('[office] session init failed', e?.message));

// PWA — 앱 셸만 캐시한다(오프라인에서 마지막 화면 열기). 개발 서버에서는 등록하지 않는다.
if (!isDesktop() && 'serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
