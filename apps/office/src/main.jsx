import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, readTheme } from './core/theme.js';
import { getLang } from './core/i18n.js';
import { initSession } from './core/session.js';
import './core/transport.js'; // 보낼 목록의 서버 전송을 등록한다
import './tokens.css';
import './base.css';

applyTheme(readTheme());
document.documentElement.lang = getLang();
createRoot(document.getElementById('root')).render(<App />);
initSession().catch((e) => console.warn('[office] session init failed', e?.message));

// PWA — 앱 셸만 캐시한다(오프라인에서 마지막 화면 열기). 개발 서버에서는 등록하지 않는다.
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js');
