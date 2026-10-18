// 메신저 v2 초대함 — 설정 → 내 계정 안의 카드 하나(기존 msgr-setcard 모양, DevicesCard와 같은 자리). 플래그가 켜졌을 때만 그린다.
// 목록은 셸이 가진 받은 초대(v2/my-invites.mjs — 사건·복귀 때만 다시 읽는다)를 그대로 받는다. 이 카드는 서버를 직접 읽지 않는다(조회 추가 0).
// 줄마다: 공간 이름 · 초대한 사람 · 손님이면 표시 · 남은 기간(v2/invite-box.mjs), 보기(기존 초대 미리보기에서 참여) · 거절.
import { useState } from 'react';
import { inviteLeft } from './invite-box.mjs';

export function InvitesCard({ invites = [], t, onView, onDecline, now = Date.now() }) {
  const [busy, setBusy] = useState(null); // 거절 중인 코드 — 그 줄 단추만 막는다
  const decline = async (code) => { setBusy(code); try { await onDecline(code); } finally { setBusy(null); } };
  return (
    <section className="msgr-setcard msgr-v2-invites">
      <h2>{t('inv.box.title')}</h2><p>{t('inv.box.desc')}</p>
      {!invites.length && <p className="note">{t('inv.box.empty')}</p>}
      {invites.length > 0 && <div className="msgr-rows">
        {invites.map((v) => { const left = inviteLeft(v.expiresAt, now); return (
          <div key={v.id} className="row">
            <div className="msgr-v2-dev">
              <strong>{v.spaceName}</strong>
              <span className="sub">{[t('inv.box.by', { name: v.inviterName || t('inbox.invite.someone') }), v.role === 'guest' && t('inv.p.guest'), t(left.key, { n: left.n })].filter(Boolean).join(' · ')}</span>
            </div>
            <button type="button" className="btn sm btn-primary" disabled={busy === v.code} onClick={() => onView(v.code)}>{t('inv.box.view')}</button>
            <button type="button" className="btn sm" disabled={busy === v.code} onClick={() => decline(v.code)}>{t('inv.p.decline')}</button>
          </div>); })}
      </div>}
    </section>
  );
}
