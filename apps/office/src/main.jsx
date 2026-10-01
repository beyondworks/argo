import { DEMO } from './core/demo.js'; // 첫 import — 체험판은 저장소를 비우고 시작
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, applyShell, readTheme, readShell } from './core/theme.js';
import { getLang } from './core/i18n.js';
import { initSession } from './core/session.js';
import { isDesktop } from './core/platform.js';
import { initDesktopAuth, initMailRelay } from './core/desktop-auth.js';
import './core/transport.js'; // 보낼 목록의 서버 전송을 등록한다
import './tokens.css';
import './base.css';
import './themes.css'; // 앱 셸 × 새 다섯 색 — base.css 뒤에 둔다(같은 토큰을 덮어쓴다)

applyTheme(readTheme());
applyShell(readShell());
document.documentElement.lang = getLang();
async function boot() {
  if (await initMailRelay()) return;
  createRoot(document.getElementById('root')).render(<App />);
  await initSession();
  await initDesktopAuth();
}
boot().catch((e) => console.warn('[office] session init failed', e?.message));

// PWA — 앱 셸만 캐시한다(오프라인에서 마지막 화면 열기). 개발 서버에서는 등록하지 않는다.
if (!DEMO && !isDesktop() && 'serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
