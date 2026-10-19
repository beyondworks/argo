// 축소판 A+ 화면 픽스처 진입 — test/aplus.fixture.html. 가짜 원본만 쓴다(네트워크 0). 상태별 캡처용 쿼리: tab·open·sheet.
import '@argo/globals.css';
import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { LanguageProvider } from '@argo/i18n';
import { ThemeProvider } from '@argo/theme';
import APlusApp from '../src/aplus/APlusApp.jsx';
import { createFakeSource } from '../src/aplus/fake.mjs';
import { Sprite } from '../src/icons.jsx';

const p = new URLSearchParams(location.search);
const source = createFakeSource({ scenario: p.get('scenario') || 'pro-many', lang: p.get('lang') || 'ko' });
if (p.get('scenario') === 'offline') Object.defineProperty(navigator, 'onLine', { get: () => false });
window.__aplus = source;

// 캡처 보조: 화면이 뜬 뒤 탭·대화·시트를 연다(사람이 누르는 것과 같은 단추를 누른다).
function Drive() {
  useEffect(() => {
    const click = (sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.includes(text)); el?.click(); return !!el; };
    const steps = [];
    const tab = p.get('tab');
    if (tab) steps.push(() => click(`.ap-seg button, .ap-tabbar button, .ap-railfoot`, { dm: '1:1', meet: p.get('lang') === 'en' ? 'Meetings' : '회의방', bots: p.get('lang') === 'en' ? 'Bots' : '외부 봇', me: p.get('lang') === 'en' ? 'Settings' : '설정' }[tab]));
    if (p.get('open')) steps.push(() => click('.ap-rows .ap-rowbtn:not(.static)', p.get('row') || undefined)); // row=이름 일부 — 그 줄을 연다
    if (p.get('sheet')) steps.push(() => click('.ap-head .btn, .ap-railbtn, .ap-note .btn-primary'));
    let i = 0; const id = setInterval(() => { if (i >= steps.length) { clearInterval(id); document.body.dataset.ready = '1'; return; } if (steps[i]()) i += 1; }, 120);
    return () => clearInterval(id);
  }, []);
  return null;
}

createRoot(document.getElementById('root')).render(
  <LanguageProvider><ThemeProvider defaultTheme="graphite"><Sprite /><APlusApp source={source} onSignOut={() => { document.body.dataset.signedOut = '1'; }} purchase={p.get('ios') ? null : { url: 'https://example.invalid/checkout' }} /><Drive /></ThemeProvider></LanguageProvider>,
);
