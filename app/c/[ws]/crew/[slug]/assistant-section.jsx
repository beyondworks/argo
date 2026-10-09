'use client';
// 에이전트 카드 "비서" 탭 — 능동 비서 켜기·끄기·바꾸기, 기본값, 상태(설계 13절).
// 저장은 설정 API(PUT /api/companies/[ws]/assistant)가 하고 이 컴포넌트는 그 응답(보기)으로 다시 그린다. 값마다 바로 저장한다(카드의 범위 칩·규칙과 같은 방식).
// 주기 호출 없음 — 탭을 열 때 1번 읽는다. 읽기·쓰기 모두 기기 로컬 파일이라 Supabase 호출 0이다. 저장 1번은 그 회사의 다음 동기화에서 파일 2개(assistant.json·company.json 봉인)
// 업로드 + 매니페스트 재읽기 1·쓰기 1이 되고, 다른 기기는 파일 2개를 내려받는다(값을 바꿀 때마다 저장 — 드문 동작이라 주기 호출이 아니다).
// 고를 필요 없는 값은 화면에 없다 — 아침 정리 시각은 조용한 시간이 끝나는 시각, 받는 곳·권한은 표시만, 볼 것은 지금 일정 하나(src/assistant/settings.mjs).
import { useEffect, useState } from 'react';
import { Skeleton, Spinner } from '../../../../ui';
import { useLang, fmtMsgTime } from '../../../../i18n';
import { errorTextFor } from '../../../../apimsg.mjs';
import { assistantRole, statusNotes, timeChoices } from './assistant-view.mjs';

// 메일 보기 — 화면 값 → 저장 값(설정 API: false | 'shadow' | true). 미리 보기 = 알리지 않고 무엇을 알렸을지만 기록(설계 18절)
const MAIL_VALUE = { off: false, shadow: 'shadow', live: true };
const MAIL_CODES = new Set(['login_required', 'mail_no_origin', 'office_outdated', 'mail_rate_limited', 'mail_expired', 'mail_error', 'no_mail_account', 'deliver_failed', 'personal_room_unavailable']);
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
const selectStyle = { height: 30, padding: '0 8px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12, color: 'var(--fg)', minWidth: 0 };

/** 한 줄 — 왼쪽 이름, 오른쪽 값. 좁은 폭에서는 이름 칸이 줄어든다(390px에서 잘리지 않게 minmax(0, …)). */
function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 8.5em) minmax(0, 1fr)', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-3)', minWidth: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, fontSize: 12, color: 'var(--fg-2)' }}>{children}</div>
    </div>
  );
}

export function AssistantSection({ ws, slug }) {
  const { t, lang } = useLang();
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
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

  async function save(patch) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setView(d); else setErr(errorTextFor(d, r.status, lang)); // 실패면 보기를 바꾸지 않는다 — 고른 값이 저장 전 값으로 돌아간다
    } catch { setErr(t('assistant.saveErr')); } finally { setBusy(false); }
  }

  if (!view) return err ? <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span> : <Skeleton h={120} />;
  const { mine, other } = assistantRole(view, ws, slug);
  const notes = statusNotes(view, ws, slug);
  const c = view.config;
  const s = view.status ?? {};
  const noteText = {
    unsealed: t('assistant.st.unsealed'),
    other_company: t('assistant.st.other_company'),
    login_required: t('assistant.st.login_required'),
    muted: t('assistant.st.muted'),
    runner_outdated: t('assistant.st.runner_outdated'),
    calendar_error: t('assistant.st.calendar_error'),
    deliver_failed: t('assistant.st.deliver_failed'),
    personal_room_unavailable: t('assistant.st.personal_room_unavailable'),
  };
  const here = s.runner === 'this_device';
  const runnerText = here ? (s.device ? t('assistant.runnerHere', { device: s.device }) : t('assistant.runnerHereBare'))
    : s.runner === 'other_device' ? t('assistant.runnerOther', { device: s.device || '—' })
      : s.runner === 'runner_outdated' ? t('assistant.runnerOld', { device: s.device || '—' })
        : t('assistant.runnerNone');
  const turnOn = () => save({ enabled: true, agent: slug, tz: localTz() });
  const n = s.instantToday ?? 0;
  const todayText = s.instantSure === false ? t('assistant.todayUnsure', { n }) // 다른 기기가 보낸 수를 아직 모름(방에서 복구 실패)
    : n > s.dailyCap ? t('assistant.todayOver', { n, cap: s.dailyCap }) : t('assistant.todayUnder', { n, cap: s.dailyCap });

  // 메일 확인 상태 — 마지막 확인 시각, 미리 보기면 기록한 수, 문제가 있으면 그 문장(src/assistant/mail.mjs mailStatusView)
  const ms = s.mail;
  const mailText = !ms?.checkedAt && !ms?.code ? t('assistant.lastCheckNone')
    : [ms.checkedAt ? fmtMsgTime(lang, ms.checkedAt) : null,
      c.mail === 'shadow' ? t('assistant.mailShadow', { days: ms.shadow?.days ?? 0, n: ms.shadow?.total ?? 0 }) : null,
      ms.code && ms.code !== 'ok' ? t(`assistant.mailSt.${MAIL_CODES.has(ms.code) ? ms.code : 'mail_error'}`) : null].filter(Boolean).join(' · ');

  return (
    <div data-assistant-section="" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('assistant.desc')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={mine ? 'pill ok' : 'pill'} data-testid="assistant-state"><span className="dot" />{mine ? t('assistant.on') : t('assistant.off')}</span>
          {mine ? (
            <button type="button" className="btn sm" data-testid="assistant-off" disabled={busy} onClick={() => save({ enabled: false })}>{t('assistant.turnOff')}</button>
          ) : !other ? (
            <button type="button" className="btn btn-primary sm" data-testid="assistant-on" disabled={busy} onClick={turnOn}>{t('assistant.turnOn')}</button>
          ) : null}
          {busy && <Spinner size={12} />}
        </div>
        {other && (
          <div style={{ display: 'grid', gap: 6, padding: '10px 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 10, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{t('assistant.current', { company: other.company, name: other.name })}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn sm" data-testid="assistant-switch" disabled={busy} onClick={turnOn}>{t('assistant.switch')}</button>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('assistant.switchHint')}</span>
            </div>
          </div>
        )}
        {notes.map((n) => (
          <p key={n} data-note={n} style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--warn)' }}>{noteText[n]}</p>
        ))}
        {err && <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
      </div>

      {mine && (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <span className="microlabel">{t('assistant.settings')}</span>
          <Row label={t('assistant.lead')}>
            <select aria-label={t('assistant.lead')} data-testid="assistant-lead" value={c.leadMinutes} disabled={busy} style={selectStyle}
              onChange={(e) => save({ leadMinutes: Number(e.target.value) })}>
              {view.choices.lead.map((n) => <option key={n} value={n}>{t('assistant.leadOpt', { n })}</option>)}
            </select>
          </Row>
          <Row label={t('assistant.evening')}>
            <select aria-label={t('assistant.evening')} data-testid="assistant-evening" value={c.eveningAt} disabled={busy} style={selectStyle}
              onChange={(e) => save({ eveningAt: e.target.value })}>
              {timeChoices(c.eveningAt).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
          <Row label={t('assistant.quiet')}>
            <select aria-label={t('assistant.quietFrom')} data-testid="assistant-quiet-from" value={c.quiet.from} disabled={busy} style={selectStyle}
              onChange={(e) => save({ quiet: { from: e.target.value } })}>
              {timeChoices(c.quiet.from).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <span aria-hidden="true" style={{ color: 'var(--fg-3)' }}>~</span>
            <select aria-label={t('assistant.quietTo')} data-testid="assistant-quiet-to" value={c.quiet.to} disabled={busy} style={selectStyle}
              onChange={(e) => save({ quiet: { to: e.target.value } })}>
              {timeChoices(c.quiet.to).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.6 }}>{t('assistant.quietHint', { to: c.quiet.to })}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer' }}>
            <input type="checkbox" data-testid="assistant-quiet-alerts" checked={c.quiet.calendarAlerts} disabled={busy}
              onChange={(e) => save({ quiet: { calendarAlerts: e.target.checked } })} />
            {t('assistant.quietAlerts')}
          </label>
          <Row label={t('assistant.watch')}>{t('assistant.watchCalendar')}</Row>
          <Row label={t('assistant.mail')}>
            <select aria-label={t('assistant.mail')} data-testid="assistant-mail" value={c.mail ?? 'off'} disabled={busy} style={selectStyle}
              onChange={(e) => save({ mail: MAIL_VALUE[e.target.value] })}>
              {Object.keys(MAIL_VALUE).map((v) => <option key={v} value={v}>{t(`assistant.mail.${v}`)}</option>)}
            </select>
          </Row>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.6 }}>{t('assistant.mailHint')}</span>
          <Row label={t('assistant.dest')}>{t('assistant.destPersonal')}</Row>
          <Row label={t('assistant.perm')}>{t('assistant.permNotify')}</Row>
        </div>
      )}

      {mine && (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <span className="microlabel">{t('assistant.status')}</span>
          <Row label={t('assistant.runner')}><span data-testid="assistant-runner" style={{ overflowWrap: 'anywhere' }}>{runnerText}</span></Row>
          <Row label={t('assistant.lastCheck')}>{!here ? t('assistant.onRunner') : s.readAt ? fmtMsgTime(lang, s.readAt) : t('assistant.lastCheckNone')}</Row>
          <Row label={t('assistant.today')}><span data-testid="assistant-today">{!here ? t('assistant.onRunner') : todayText}</span></Row>
          {c.mail && c.mail !== 'off' && (
            <Row label={t('assistant.mailCheck')}>
              <span data-testid="assistant-mail-status" style={{ overflowWrap: 'anywhere' }}>{!here ? t('assistant.onRunner') : mailText}</span>
            </Row>
          )}
        </div>
      )}
    </div>
  );
}
