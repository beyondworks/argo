// 초대 창 시안·행동 확인용 픽스처 — 앱 전체 없이 창만 띄운다. ?v=admin|host|preview(&state=valid|already_member|expired) &theme=linen-light|linen-dark &lang=ko|en &phone=1
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '@argo/globals.css';
import '../src/styles.css';
import '../src/invite-dialog.css';
import { Sprite, I } from '../src/icons.jsx';
import { t as tm } from '../src/i18n.js';
import { inviteShareText } from '../src/invite.mjs';
import { InviteDialog, InvitePreview } from '../src/invite-dialog.jsx';

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
const create = async (opts) => { calls.push(opts); await new Promise((r) => setTimeout(r, 300)); return { id: `inv-${calls.length}`, code: hex() }; };

const PREVIEW = { state: q.get('state') || 'valid', org_id: 'org', org_name: 'Lean-AX', channels: [CHANNELS[0], CHANNELS[2]], inviter_name: '김효율', role: 'member', expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString() };

function App() {
  const [open, setOpen] = useState(true);
  if (v === 'preview') return <><Sprite />{open && <InvitePreview p={PREVIEW} avatar={<span className="msgr-av lg">L</span>} onJoin={() => calls.push('join')} onOpen={() => calls.push('open')} onClose={() => setOpen(false)} fmtWhen={(iso) => new Date(iso).toLocaleDateString()} t={t} phone={phone} />}</>;
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
