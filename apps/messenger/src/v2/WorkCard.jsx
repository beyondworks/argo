// 메신저 v2 일 카드(U6 ②) — 에이전트 일 1건을 시킨 글 아래 승인 카드(msgr-slip) 모양으로 그린다. 상태 계산은 work-card.mjs(순수), 이 파일은 그리기만.
// U6c에서 기존 셸(App.jsx)의 글 목록 안에 끼운다. 문구는 사전(v2.work.*·v2.ap.*·v2.sys.error.*)만 쓴다.
import { useEffect } from 'react';
import { I } from '../icons.jsx';

export function WorkCard({ card, t, nameOf, busy, onDecide, onCancel, onEffects }) {
  const agent = nameOf('agent', card.agentId);
  const ap = card.approval;
  const tone = card.phase === 'approval' ? 'pending' : ['done'].includes(card.phase) ? 'approved' : ['failed', 'unknown'].includes(card.phase) ? 'rejected' : 'expired';
  const icon = { waiting: 'clock', received: 'check', working: 'node', approval: 'stamp', done: 'check', failed: 'x', cancelled: 'x', expired: 'clock', unknown: 'clock' }[card.phase] ?? 'node';
  useEffect(() => { if (card.phase === 'unknown') onEffects(card.workId); }, [card.phase, card.workId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`msgr-slip msgr-v2-work ${tone} phase-${card.phase}`} role="group" aria-label={t('v2.work.agent', { agent })} data-work={card.workId}>
      <div className="band"><I name={icon} size={14} /><span className="v2-band-text">{t('v2.work.agent', { agent })} · {t(`v2.work.${card.phase}`)}</span>{card.late && <span className="msgr-klabel risk">{t('v2.work.late')}</span>}</div>
      {(card.stage || card.error || card.unknownEffects.length > 0 || ap || card.canCancel) && <div className="body">
        {card.stage && <div className="reason">{t(`v2.work.stage.${card.stage}`)}</div>}
        {card.error && <div className="reason">{t(`v2.sys.error.${card.error}`, { agent })}</div>}
        {card.unknownEffects.length > 0 && <div className="reason">{t('v2.work.unknownEffects', { list: card.unknownEffects.join(', ') })}</div>}
        {ap && (<>
          <div className="msgr-klabel">{t('v2.ap.request')} · {t(`v2.ap.risk.${ap.risk}`)}</div>
          <div className="action">{ap.action}</div>
          {ap.summary && <div className="reason">{ap.summary}</div>}
        </>)}
        <div className="row2">
          {ap && card.canDecide && (<>
            <button type="button" className="btn btn-primary sm" disabled={!!busy} onClick={() => onDecide(card, 'approve')}>{busy === `${card.workId}:approve` ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="check" size={13} />}{t(busy === `${card.workId}:approve` ? 'v2.ap.deciding' : 'v2.ap.approve')}</button>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => onDecide(card, 'reject')}>{busy === `${card.workId}:reject` ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="x" size={13} />}{t(busy === `${card.workId}:reject` ? 'v2.ap.deciding' : 'v2.ap.reject')}</button>
          </>)}
          {ap && ap.state === 'pending' && !card.canDecide && <span className="note">{t('v2.ap.ownerOnly')}</span>}
          {ap && ap.state !== 'pending' && <span className={`msgr-seal${ap.state === 'approved' ? ' ok' : ap.state === 'rejected' ? ' no' : ''}`}>{t(`v2.ap.${ap.state}`)}</span>}
          {card.canCancel && <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => onCancel(card)}><I name="x" size={13} />{t('v2.work.cancel')}</button>}
        </div>
      </div>}
    </div>
  );
}
