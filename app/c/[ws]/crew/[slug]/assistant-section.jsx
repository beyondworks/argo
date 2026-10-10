'use client';
// 에이전트 카드 "하트비트" 탭 — 보기 전용(유건 10/10: 카드에서는 지금 설정된 하트비트 현황을 보고, 만들기·관리·정지·주기·끄고 켜기는 루틴 화면에서).
// 켜짐 여부·맡은 에이전트·확인 주기·알림 설정 요약·메일 확인·실행 기기·마지막 확인·오늘 보낸 알림 수/한도를 보이고, '루틴에서 관리'로 루틴 화면의 하트비트 칸으로 간다.
// 주기 호출 없음 — 탭을 열 때 1번 읽는다(GET /api/companies/[ws]/assistant). 읽기는 기기 로컬 파일이라 Supabase 호출 0이다. 이 탭은 쓰지 않는다.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '../../../../ui';
import { useLang, fmtMsgTime } from '../../../../i18n';
import { errorTextFor } from '../../../../apimsg.mjs';
import { keepSide } from '../../split.mjs';
import { assistantRole, heartbeatState, statusNotes, statusTexts } from './assistant-view.mjs';

/** 한 줄 — 왼쪽 이름, 오른쪽 값. 좁은 폭에서는 이름 칸이 줄어든다(390px에서 잘리지 않게 minmax(0, …)). */
function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 8.5em) minmax(0, 1fr)', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-3)', minWidth: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, fontSize: 12, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

/** 루틴 화면의 하트비트 칸 주소 — 옆에 열어 둔 보조 패널(?side=)을 그대로 싣는다(split.mjs keepSide). */
export const manageHref = (ws, search) => keepSide(`/c/${ws}/routines#heartbeat`, search); // withSide가 #을 뒤에 둔다

export function AssistantSection({ ws, slug }) {
  const { t, lang } = useLang();
  const router = useRouter();
  const [view, setView] = useState(null);
  const [err, setErr] = useState('');
  const url = `/api/companies/${ws}/assistant`;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(url);
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) setView(d); else setErr(errorTextFor(d, r.status, lang));
      } catch { if (alive) setErr(t('assistant.loadErr')); }
    })();
    return () => { alive = false; };
  }, [url]); // 탭을 열 때 1번 — 언어가 바뀌어도 다시 읽지 않는다(문구는 사전이 다시 그린다)

  if (!view) return err ? <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span> : <Skeleton h={120} />;
  const { mine, other } = assistantRole(view, ws, slug);
  const state = heartbeatState(view, ws);
  const c = view.config;
  const pausedHere = state === 'paused' && c.agent === slug; // 이 에이전트가 맡은 채 일시 정지
  const notes = statusNotes(view, ws, slug);
  const st = statusTexts(view, { t, fmt: (ms) => fmtMsgTime(lang, ms) });
  const summary = mine || pausedHere;
  const line = mine ? t('assistant.card.mine')
    : other ? t('assistant.current', { company: other.company, name: other.name })
      : state === 'paused' ? t('assistant.card.paused', { name: c.agentName || c.agent })
        : t('assistant.card.none');
  const manage = () => router.push(keepSide(`/c/${ws}/routines#heartbeat`, window.location.search)); // = manageHref — router.push 스위프 검사(test/commander-keep-side)가 알아보는 모양 그대로

  return (
    <div data-assistant-section="" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('assistant.hb.desc')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={mine ? 'pill ok' : 'pill'} data-testid="assistant-state"><span className="dot" />{mine ? t('assistant.on') : t('assistant.off')}</span>
          <span data-testid="assistant-line" style={{ fontSize: 12, color: 'var(--fg-2)', overflowWrap: 'anywhere', minWidth: 0 }}>{line}</span>
        </div>
        {notes.map((n) => (
          <p key={n} data-note={n} style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--warn)' }}>{t(`assistant.st.${n}`)}</p>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn sm" data-testid="assistant-manage" onClick={manage}>{t('assistant.manage')}</button>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.6 }}>{t('assistant.card.viewOnly')}</span>
        </div>
      </div>

      {summary && (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }} data-testid="assistant-summary">
          <span className="microlabel">{t('assistant.settings')}</span>
          <Row label={t('assistant.watch')}>{[c.calendar !== false ? t('assistant.watchCalendar') : null, c.mail && c.mail !== 'off' ? `${t('assistant.mail')}${c.mail === 'shadow' ? ` (${t('assistant.hb.previewShort')})` : ''}` : null].filter(Boolean).join(' · ') || '—'}</Row>
          <Row label={t('assistant.interval')}><span data-testid="assistant-interval">{t('assistant.intervalOpt', { n: c.intervalMinutes ?? 15 })}</span></Row>
          <Row label={t('assistant.lead')}>{t('assistant.leadOpt', { n: c.leadMinutes })}</Row>
          <Row label={t('assistant.hb.morning')}>{c.quiet.to}</Row>
          <Row label={t('assistant.evening')}>{c.eveningAt}</Row>
          <Row label={t('assistant.hb.quiet')}>{`${c.quiet.from} ~ ${c.quiet.to}`}{c.quiet.calendarAlerts ? ` · ${t('assistant.quietAlertsOn')}` : ''}</Row>
          <Row label={t('assistant.agent')}>{c.agentName || c.agent}</Row>
          <Row label={t('assistant.dest')}>{t('assistant.destPersonal')}</Row>
        </div>
      )}

      {mine && (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <span className="microlabel">{t('assistant.status')}</span>
          <Row label={t('assistant.runner')}><span data-testid="assistant-runner">{st.runner}</span></Row>
          <Row label={t('assistant.lastCheck')}>{st.lastCheck}</Row>
          <Row label={t('assistant.today')}><span data-testid="assistant-today">{st.today}</span></Row>
          {st.mail != null && <Row label={t('assistant.mailCheck')}><span data-testid="assistant-mail-status">{st.mail}</span></Row>}
        </div>
      )}
    </div>
  );
}
