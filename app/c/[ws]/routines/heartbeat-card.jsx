'use client';
// 루틴 화면 맨 위 "내 하트비트" — 하트비트(코드 이름 assistant)를 켜고 끄고, 무엇을·언제·얼마나 자주·누가 알려 줄지 한 화면에서 고른다.
// 유건 10/10: "하트비트 루틴 만들기, 관리, 정지, 주기 변경, 끄고 켜기 등은 '루틴' 페이지에" + "개인적으로 이용하는 기능… 설정 자체도 직관적이고 쉬워야".
// 개인 기능이라 회사 루틴 목록과 섞지 않고 위에 따로 둔다. 에이전트 카드의 하트비트 탭은 보기 전용이다(crew/[slug]/assistant-section.jsx).
// 이 칸 아래에 목표형 하트비트 목록(다른 작업)이 붙는다 — 그 자리는 이 섹션(<section id="heartbeat">)의 다음 자식이다. 빈 자리·버튼은 만들지 않는다.
//
// 저장은 설정 API(/api/companies/[ws]/assistant — PUT 값 저장, DELETE 설정 지우기)가 하고 이 컴포넌트는 그 응답(보기)으로 다시 그린다.
//  - 설정이 있으면(켜짐·꺼 둠) 값을 고르는 즉시 저장한다. 스위치 끄기 = 꺼 둠(설정 남음), 켜기 = 그 설정으로 다시 켜기.
//  - 설정이 없으면(처음·지운 뒤·다른 회사로 옮겨 꺼짐) 고른 값은 화면에만 있다가 스위치를 켤 때 한 번에 저장한다(PUT 1번).
//  - '설정 지우기'(고급, 확인 창)는 DELETE — 다시 쓰려면 처음부터 고른다.
// 주기 호출 없음 — 화면을 열 때 1번 읽는다. 읽기·쓰기 모두 기기 로컬 파일이라 Supabase 호출 0이다. 저장 1번은 그 회사의 다음 동기화에서 파일 2개(assistant.json·company.json 봉인)
// 업로드 + 매니페스트 재읽기 1·쓰기 1이 되고, 다른 기기는 파일 2개를 내려받는다(값을 바꿀 때마다 — 드문 동작이라 주기 호출이 아니다). 지우기는 assistant.json 1개.
// 계정마다 하나(src/assistant/settings.mjs): 켜면 같은 계정의 다른 회사 하트비트는 꺼진다 — 그 안내(assistant.hb.desc·switchHint)를 보인다.
// 화면에는 내부 용어(봉인·러너·리스·틱)를 내보내지 않는다.
import { useEffect, useRef, useState } from 'react';
import { Icon, Skeleton, Spinner, ConfirmModal } from '../../../ui';
import { useLang, fmtMsgTime } from '../../../i18n';
import { errorTextFor } from '../../../apimsg.mjs';
import { heartbeatState, statusNotes, statusTexts, timeChoices, numChoices } from '../crew/[slug]/assistant-view.mjs';

const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
const selectStyle = { height: 30, padding: '0 8px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, color: 'var(--fg)', minWidth: 0, maxWidth: '100%' };
const hint = { fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.6, margin: 0 };
const check = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-2)', cursor: 'pointer' };

/** 묶음 하나 — 쉬운 질문 제목 + 칸들. */
function Group({ title, children, ...rest }) {
  return (
    <div {...rest} style={{ display: 'grid', gap: 8, minWidth: 0, alignContent: 'start' }}>
      <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--fg)' }}>{title}</span>
      {children}
    </div>
  );
}
/** 한 줄 — 왼쪽 이름, 오른쪽 값. 좁은 폭에서는 이름 칸이 줄어든다(390px에서 잘리지 않게 minmax(0, …)). */
function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 9em) minmax(0, 1fr)', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-3)', minWidth: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, fontSize: 12, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

/** 화면 값 — 보기의 config(설정이 없으면 기본값)를 한 모양으로. 담당: 설정이 있으면 저장된 담당 그대로(해고됐어도 — 화면이 다른 에이전트가 맡은 것처럼
    보이지 않게, 분리 검수 M2), 설정이 없으면 이 회사의 첫 에이전트. */
function valuesOf(view, agents) {
  const c = view.config;
  const agent = c.agent || (agents[0]?.slug ?? '');
  return {
    agent, calendar: c.calendar !== false, mail: c.mail ?? 'off', intervalMinutes: c.intervalMinutes ?? 15, leadMinutes: c.leadMinutes,
    eveningAt: c.eveningAt, quiet: { ...c.quiet },
  };
}
const MAIL_SAVE = { off: false, shadow: 'shadow', live: true };

export function HeartbeatCard({ ws, agents = [], agentsLoaded = true }) {
  const { t, lang } = useLang();
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(null); // 설정이 없을 때 고른 값(켤 때 한 번에 저장)
  const [confirmClear, setConfirmClear] = useState(false);
  const scrolled = useRef(false);
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
  }, [url]); // 화면을 열 때 1번 — 언어가 바뀌어도 다시 읽지 않는다

  // 카드 탭의 '루틴에서 관리'(#heartbeat)로 왔으면 다 읽은 뒤 이 칸을 화면에 맞춘다(한 번)
  useEffect(() => {
    if (!view || scrolled.current || typeof window === 'undefined' || window.location.hash !== '#heartbeat') return;
    scrolled.current = true;
    document.getElementById('heartbeat')?.scrollIntoView({ block: 'start' });
  }, [view]);

  async function send(method, patch) {
    if (busy) return false;
    setBusy(true); setErr('');
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(patch ? { body: JSON.stringify(patch) } : {}) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setView(d); setDraft(null); return true; }
      setErr(errorTextFor(d, r.status, lang)); // 실패면 보기를 바꾸지 않는다 — 고른 값이 저장 전 값으로 돌아간다
      return false;
    } catch { setErr(t('assistant.saveErr')); return false; } finally { setBusy(false); }
  }

  const head = (right) => (
    <div className="card-head" style={{ flexWrap: 'wrap', rowGap: 6 }}>
      <span className="card-title"><Icon name="pulse" size={14} />{t('assistant.hb.title')}</span>
      <span className="chip" style={{ textTransform: 'none', fontSize: 10.5, minHeight: 20 }}>{t('assistant.hb.personal')}</span>
      <span className="rule" />
      {right}
    </div>
  );
  if (!view) {
    return (
      <section id="heartbeat" data-my-heartbeat="" style={{ display: 'grid', gap: 12, scrollMarginTop: 72 /* 붙어 있는 상단 바(56px) 아래로 */ }}>
        <div className="card">{head(null)}<div style={{ padding: '0 20px 18px' }}>{err ? <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span> : <Skeleton h={80} />}</div></div>
      </section>
    );
  }

  const state = heartbeatState(view, ws);
  const c = view.config;
  const hasSettings = !!c.agent; // 이 회사에 봉인된 설정(켜짐·꺼 둠)이 있다 — 없으면 고른 값은 켤 때 저장
  const on = state === 'on';
  const base = valuesOf(view, agents);
  const v = draft ? { ...draft, agent: draft.agent || base.agent } : base; // 에이전트 목록이 늦게 와도 담당이 빈 값으로 굳지 않게(L7)
  const agentGone = hasSettings && agentsLoaded && !agents.some((a) => a.slug === c.agent); // 저장된 담당이 이 회사에 없다(해고·이름 바꿈) — 엔진은 쉰다(tick.mjs no_agent)
  const cur = view.current;
  const notes = statusNotes(view, ws);
  const st = statusTexts(view, { t, fmt: (ms) => fmtMsgTime(lang, ms) });
  const intervals = view.choices?.interval ?? [10, 15, 30, 60];
  const noAgents = agentsLoaded && !agents.length;

  /** 값 바꾸기 — 설정이 있으면 바로 저장(바뀐 칸만), 없으면 화면 값만. */
  const change = (patch, save) => {
    if (hasSettings) { send('PUT', save ?? patch); return; }
    setDraft({ ...v, ...patch, quiet: { ...v.quiet, ...(patch.quiet ?? {}) } });
  };
  const toggle = () => {
    if (on) { send('PUT', { enabled: false }); return; } // 꺼 둠 — 설정은 남는다
    if (hasSettings) { if (!agentGone) send('PUT', { enabled: true, agent: v.agent, tz: localTz() }); return; } // 그 설정으로 다시 켜기(다른 회사 하트비트는 꺼진다). 담당이 없으면 먼저 '누가'에서 고른다
    if (!v.agent) return;
    send('PUT', { enabled: true, agent: v.agent, tz: localTz(), calendar: v.calendar, mail: MAIL_SAVE[v.mail] ?? false, intervalMinutes: v.intervalMinutes, leadMinutes: v.leadMinutes, eveningAt: v.eveningAt, quiet: v.quiet });
  };
  const agentOptions = agents.map((a) => ({ value: a.slug, label: a.role ? `${a.name} — ${a.role}` : a.name }));
  if (v.agent && !agentOptions.some((o) => o.value === v.agent)) agentOptions.unshift({ value: v.agent, label: agentsLoaded ? t('assistant.hb.agentGone', { name: c.agentName || v.agent }) : (c.agentName || v.agent) }); // 목록에 없는 담당(해고 등)도 지금 값으로 — 고르면 바로 바뀐다
  const mailOn = v.mail !== 'off';
  const line = on ? [`${t('assistant.lastCheck')}: ${st.lastCheck}`, `${t('assistant.today')}: ${st.today}`].join(' · ')
    : cur ? t('assistant.current', { company: cur.company, name: cur.name })
      : hasSettings ? t('assistant.hb.stPaused') : t('assistant.hb.stNone');

  const sw = (
    <button type="button" role="switch" aria-checked={on} aria-label={t('assistant.hb.switch')} data-testid="assistant-switch"
      disabled={busy || (!on && (hasSettings ? agentGone : (!v.agent || noAgents)))} onClick={toggle}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--fg-2)', fontSize: 12.5 }}>
      {busy && <Spinner size={12} />}
      <span data-testid="assistant-state">{on ? t('assistant.on') : t('assistant.off')}</span>
      <span aria-hidden="true" style={{ position: 'relative', width: 36, height: 20, borderRadius: 999, background: on ? 'var(--primary)' : 'var(--border)', transition: 'background .15s', flex: 'none' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 999, background: 'var(--card)', boxShadow: '0 1px 2px rgba(0,0,0,.2)', transition: 'left .15s' }} />
      </span>
    </button>
  );

  return (
    <section id="heartbeat" data-my-heartbeat="" style={{ display: 'grid', gap: 12, scrollMarginTop: 72 /* 붙어 있는 상단 바(56px) 아래로 */ }}>
      {confirmClear && (
        <ConfirmModal
          title={t('assistant.hb.clearTitle')}
          description={t('assistant.hb.clearConfirm')}
          confirmLabel={t('assistant.hb.clear')}
          tone="danger"
          onConfirm={() => { setConfirmClear(false); send('DELETE'); }}
          onClose={() => setConfirmClear(false)}
        />
      )}
      <div className="card" data-heartbeat-card="">
        {head(sw)}
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 14, minWidth: 0 }}>
          <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('assistant.hb.desc')}</p>
            <span data-testid="assistant-line" style={{ fontSize: 12, color: on ? 'var(--fg-2)' : 'var(--fg-3)', overflowWrap: 'anywhere' }}>{line}</span>
            {cur && !on && <span style={{ ...hint, color: 'var(--warn)' }}>{t('assistant.switchHint')}</span>}
            {noAgents && <span style={hint}>{t('assistant.hb.noAgents')}</span>}
            {agentGone && !noAgents && <p data-note="no_agent" style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--warn)' }}>{t('assistant.st.no_agent')}</p>}
            {cur && !on && hasSettings && <span style={hint}>{t('assistant.hb.otherValues')}</span>}
            {notes.map((n) => <p key={n} data-note={n} style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--warn)' }}>{t(`assistant.st.${n}`)}</p>)}
            {err && <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: '18px 32px', minWidth: 0 }}>
            <Group title={t('assistant.hb.what')} data-testid="assistant-what">
              <label style={check}>
                <input type="checkbox" data-testid="assistant-calendar" checked={v.calendar} disabled={busy || (v.calendar && !mailOn)}
                  onChange={(e) => change({ calendar: e.target.checked })} />
                {t('assistant.watchCalendar')}
              </label>
              <label style={check}>
                <input type="checkbox" data-testid="assistant-mail" checked={mailOn} disabled={busy || (mailOn && !v.calendar)}
                  onChange={(e) => change({ mail: e.target.checked ? 'live' : 'off' }, { mail: e.target.checked })} />
                {t('assistant.mail')}
              </label>
              <p style={hint}>{t('assistant.hb.mailHint')}</p>
            </Group>

            <Group title={t('assistant.hb.when')} data-testid="assistant-when">
              <Row label={t('assistant.lead')}>
                <select aria-label={t('assistant.lead')} data-testid="assistant-lead" value={v.leadMinutes} disabled={busy} style={selectStyle} onChange={(e) => change({ leadMinutes: Number(e.target.value) })}>
                  {numChoices(view.choices.lead, v.leadMinutes).map((n) => <option key={n} value={n}>{t('assistant.leadOpt', { n })}</option>)}
                </select>
              </Row>
              <Row label={t('assistant.hb.morning')}>
                <select aria-label={t('assistant.hb.morning')} data-testid="assistant-quiet-to" value={v.quiet.to} disabled={busy} style={selectStyle} onChange={(e) => change({ quiet: { to: e.target.value } })}>
                  {timeChoices(v.quiet.to).map((x) => <option key={x} value={x} disabled={x === v.quiet.from}>{x}</option>)}
                </select>
              </Row>
              <Row label={t('assistant.evening')}>
                <select aria-label={t('assistant.evening')} data-testid="assistant-evening" value={v.eveningAt} disabled={busy} style={selectStyle} onChange={(e) => change({ eveningAt: e.target.value })}>
                  {timeChoices(v.eveningAt).map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Row>
            </Group>

            <Group title={t('assistant.hb.quiet')} data-testid="assistant-quiet">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--fg-2)' }}>
                <select aria-label={t('assistant.quietFrom')} data-testid="assistant-quiet-from" value={v.quiet.from} disabled={busy} style={selectStyle} onChange={(e) => change({ quiet: { from: e.target.value } })}>
                  {/* 시작 = 끝(아침 정리)이면 방해 금지 시간이 없어진다 — 고를 수 없게(서버도 막는다: assistant_quiet_empty) */}
                  {timeChoices(v.quiet.from).map((x) => <option key={x} value={x} disabled={x === v.quiet.to}>{x}</option>)}
                </select>
                <span>{t('assistant.hb.quietUntil', { to: v.quiet.to })}</span>
              </div>
              <p style={hint}>{t('assistant.hb.quietHint')}</p>
              <label style={check}>
                <input type="checkbox" data-testid="assistant-quiet-alerts" checked={v.quiet.calendarAlerts} disabled={busy} onChange={(e) => change({ quiet: { calendarAlerts: e.target.checked } })} />
                {t('assistant.hb.quietAlerts')}
              </label>
            </Group>

            <Group title={t('assistant.hb.often')} data-testid="assistant-often">
              <select aria-label={t('assistant.hb.often')} data-testid="assistant-interval" value={v.intervalMinutes} disabled={busy} style={{ ...selectStyle, justifySelf: 'start' }} onChange={(e) => change({ intervalMinutes: Number(e.target.value) })}>
                {numChoices(intervals, v.intervalMinutes).map((n) => <option key={n} value={n}>{t('assistant.intervalOpt', { n })}</option>)}
              </select>
              <p style={hint}>{t('assistant.intervalHint')}</p>
            </Group>

            <Group title={t('assistant.hb.who')} data-testid="assistant-who">
              <select aria-label={t('assistant.hb.who')} data-testid="assistant-agent" value={v.agent} disabled={busy || noAgents} style={{ ...selectStyle, justifySelf: 'start' }}
                onChange={(e) => change({ agent: e.target.value }, on ? { enabled: true, agent: e.target.value, tz: localTz() } : { agent: e.target.value })}>
                {agentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p style={hint}>{t('assistant.hb.whoHint')}</p>
            </Group>
          </div>

          <p style={hint} data-testid="assistant-chat-hint">{t('assistant.hb.chatHint')}</p>

          <details data-testid="assistant-advanced" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <summary style={{ fontSize: 12, color: 'var(--fg-3)', cursor: 'pointer' }}>{t('assistant.hb.advanced')}</summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 10, minWidth: 0 }}>
              {mailOn && (
                <label style={check}>
                  <input type="checkbox" data-testid="assistant-mail-preview" checked={v.mail === 'shadow'} disabled={busy}
                    onChange={(e) => change({ mail: e.target.checked ? 'shadow' : 'live' }, { mail: e.target.checked ? 'shadow' : true })} />
                  {t('assistant.hb.mailPreview')}
                </label>
              )}
              {mailOn && <p style={hint}>{t('assistant.mailHint')}</p>}
              <Row label={t('assistant.dest')}>{t('assistant.destPersonal')}</Row>
              <Row label={t('assistant.perm')}>{t('assistant.permNotify')}</Row>
              {on && <Row label={t('assistant.runner')}><span data-testid="assistant-runner">{st.runner}</span></Row>}
              {on && st.mail != null && <Row label={t('assistant.mailCheck')}><span data-testid="assistant-mail-status">{st.mail}</span></Row>}
              {hasSettings && (
                <div>
                  <button type="button" className="btn sm" data-testid="assistant-clear" disabled={busy} onClick={() => setConfirmClear(true)}>{t('assistant.hb.clear')}</button>
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
      {/* 목표형 하트비트 목록(feat/goal-heartbeat)이 이 섹션의 다음 자식으로 붙는다 */}
    </section>
  );
}
