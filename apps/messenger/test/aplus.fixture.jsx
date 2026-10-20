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
    if (tab) steps.push(() => click(`.ap-seg button, .ap-tabbar button, .ap-railfoot`, { dm: '1:1', meet: p.get('lang') === 'en' ? 'Meetings' : '회의방', people: p.get('lang') === 'en' ? 'People' : '사람', bots: p.get('lang') === 'en' ? 'Bots' : '외부 봇', me: p.get('lang') === 'en' ? 'Settings' : '설정' }[tab]));
    if (p.get('open')) steps.push(() => click('.ap-rows .ap-rowbtn:not(.static)', p.get('row') || undefined)); // row=이름 일부 — 그 줄을 연다
    if (p.get('sheet')) steps.push(() => click('.ap-head .btn, .ap-railbtn, .ap-note .btn-primary'));
    // 사람 탭 시트: psheet=members|invite|spaces|newChannel|newSpace|join|preview(받은 초대 첫 줄)
    const ps = p.get('psheet');
    if (ps) steps.push(() => ps === 'preview' ? click('.ap-invrow') : ps === 'spaces' ? click('.ap-spacebtn') : ps === 'newChannel' ? click('.ap-sec h3 .ap-iconbtn') : ps === 'members' ? click('.ap-head .btn, .ap-railbtn .btn, .ap-headend', p.get('lang') === 'en' ? 'Members' : '멤버') || click('.ap-headend') : ps === 'invite' ? click('.ap-head .btn, .ap-railbtn .btn', p.get('lang') === 'en' ? 'Invite' : '초대') : ps === 'newSpace' || ps === 'join' ? (click('.ap-spacebtn') || true) : false);
    if (ps === 'newSpace' || ps === 'join') steps.push(() => click('.ap-sheet .btn', ps === 'join' ? (p.get('lang') === 'en' ? 'Join' : '초대 코드') : (p.get('lang') === 'en' ? 'New team' : '새 팀')));
    if (p.get('invitefree')) steps.push(() => { const b = [...document.querySelectorAll('.ap-sheet .ap-rowbtn')].find((e) => e.textContent.includes(p.get('lang') === 'en' ? 'Free Jung' : '정무료')); b?.querySelector('.btn')?.click(); return !!b; }); // 무료 상대에게 지정 초대 → 만들어진다(수락 때 서버가 판정)
    if (p.get('accept')) steps.push(() => click('.ap-sheet .btn-primary')); // 받은 초대 참여(scenario=invite-free면 서버가 Pro 아님으로 거부)
    if (p.get('attach')) steps.push(() => { // 첨부 칩: 파일 고르기와 같은 change 사건(네트워크 없음)
      const input = document.querySelector('.ap-composer input[type=file]'); if (!input) return false;
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(240_120)], p.get('lang') === 'en' ? 'launch-checklist.pdf' : '출시-체크리스트.pdf', { type: 'application/pdf' })); dt.items.add(new File([new Uint8Array(312_400)], 'landing-v3.png', { type: 'image/png' }));
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;
    });
    let i = 0; const id = setInterval(() => { if (i >= steps.length) { clearInterval(id); document.body.dataset.ready = '1'; return; } if (steps[i]()) i += 1; }, 120);
    return () => clearInterval(id);
  }, []);
  return null;
}

createRoot(document.getElementById('root')).render(
  <LanguageProvider><ThemeProvider defaultTheme="linen"><Sprite /><APlusApp source={source} onSignOut={() => { document.body.dataset.signedOut = '1'; }} purchase={p.get('ios') ? null : { url: 'https://example.invalid/checkout' }} /><Drive /></ThemeProvider></LanguageProvider>,
);
