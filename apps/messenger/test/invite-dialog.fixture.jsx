// 초대 창 시안·행동 확인용 픽스처 — 앱 전체 없이 창만 띄운다. ?v=admin|host|member &theme=linen-light|linen-dark &lang=ko|en &phone=1
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '@argo/globals.css';
import '../src/styles.css';
import '../src/invite-dialog.css';
import { Sprite, I } from '../src/icons.jsx';
import { t as tm } from '../src/i18n.js';
import { inviteShareText } from '../src/invite.mjs';
import { InviteDialog } from '../src/invite-dialog.jsx';

const q = new URLSearchParams(location.search);
const v = q.get('v') || 'admin', lang = q.get('lang') || 'ko', phone = q.get('phone') === '1';
document.documentElement.dataset.theme = q.get('theme') || 'linen-light';
const t = (k, vars) => tm(k, lang, vars);
const CHANNELS = [
  { id: 'lean', name: 'Lean Crew', kind: 'public' }, { id: 'gen', name: 'general', kind: 'public' },
  { id: 'design', name: '디자인 비공개', kind: 'private' }, { id: 'ops', name: '운영 비공개', kind: 'private' },
  { id: 'launch', name: '2026 하반기 제품 출시 준비와 파트너 협업', kind: 'public' },
];
const calls = (window.__inv = { calls: [], closed: 0 }).calls;
const hex = () => Array.from({ length: 48 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const create = async (opts) => { calls.push(opts); await new Promise((r) => setTimeout(r, 300)); return hex(); };

function MemberPanels() { // 일반 멤버: A(요청 버튼) / B(숨김) 비교
  const panel = (variant) => (
    <aside className="msgr-crewsheet" style={{ position: 'static', width: 340 }} aria-label={variant}>
      <div className="msgr-klabel" style={{ marginBottom: 6 }}>{variant === 'A' ? 'A — 요청 버튼' : 'B — 숨김'}</div>
      <div className="sec-head"><h3>{t('ch.composition') || '이 채널의 사람과 에이전트'}</h3><span className="sub">3명 · 에이전트 1</span></div>
      {['나', '동료', 'crystal'].map((n) => <div key={n} className="pick"><span className="msgr-av sm">{n.slice(0, 1)}</span><span>{n}</span></div>)}
      {variant === 'A'
        ? <button type="button" className="btn sm" style={{ justifySelf: 'start' }}><I name="plus" size={13} />{t('inv.request')}</button>
        : null}
      <p className="note">{t('inv.request.note')}</p>
    </aside>);
  return <div style={{ display: 'flex', gap: 24, padding: 24, flexWrap: 'wrap' }}>{panel('A')}{panel('B')}</div>;
}

function App() {
  const [open, setOpen] = useState(true);
  if (v === 'member') return <><Sprite /><MemberPanels /></>;
  const props = v === 'host'
    ? { isAdmin: false, hostOf: new Set(['design']), initialChannelIds: ['design'] }
    : { isAdmin: true, hostOf: new Set(), initialChannelIds: ['lean'] };
  return <><Sprite />
    <div style={{ padding: 24 }}><button type="button" className="btn" onClick={() => setOpen(true)}>{t('inv.here')}</button></div>
    {open && <InviteDialog org={{ id: 'org', name: 'Lean-AX' }} channels={CHANNELS} {...props} create={create} t={t} phone={phone}
      linkOf={(code) => `${location.origin}/?invite=${code}`} shareText={(code) => inviteShareText(code, { origin: location.origin, pathname: '/', t })}
      onClose={() => { window.__inv.closed++; setOpen(false); }} onManage={() => {}} />}
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
