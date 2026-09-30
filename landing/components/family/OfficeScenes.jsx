'use client';

import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/lib/i18n';
import CrewFace from '@/components/family/CrewFace';
import Icon from '@/components/family/Icon';

// 오피스 모듈 카드 — 앱의 확정 규칙(9/29): 머리 42px·아이콘+13px 제목·오른쪽 모두 보기, 숫자는 Mono.
// 옐로는 결재를 기다리는 표시에만 쓴다(pending).
export const MODULES = {
  mail: { icon: 'mail', rows: 3 },
  pages: { icon: 'page', rows: 3 },
  msgr: { icon: 'chat', rows: 2 },
  crew: { icon: 'handoff', rows: 2 },
  translate: { icon: 'translate', rows: 2 },
  approve: { icon: 'stamp', rows: 2, pending: true },
};

export function Module({ id, style, className = '' }) {
  const { t } = useLang();
  const m = MODULES[id];
  return (
    <article className={`o-module${m.pending ? ' pending' : ''} ${className}`} style={style}>
      <header className="o-module-head">
        <Icon name={m.icon} size={16} />
        <span className="o-module-title">{t(`office.mod.${id}`)}</span>
        <span className="o-module-all">{t('office.mod.all')}</span>
      </header>
      <div className="o-module-body">
        <div className="o-metric">
          <span className="num">{t(`office.mod.${id}.n`)}</span>
          <span className="unit">{t(`office.mod.${id}.unit`)}</span>
        </div>
        <ul className="o-rows">
          {Array.from({ length: m.rows }, (_, i) => (
            <li key={i}>
              <span className="main">{t(`office.mod.${id}.r${i + 1}`)}</span>
              <span className="meta">{t(`office.mod.${id}.m${i + 1}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

// 문제 → 해결 스크롤의 결과: 흩어진 창들이 오피스 한 화면(모듈 4칸)으로 모인다.
export function MergedDesk() {
  const { t } = useLang();
  return (
    <div className="od-desk">
      <div className="od-bar">Argo Office<span>{t('office.prob.today')}</span></div>
      <div className="od-grid">
        {['mail', 'pages', 'msgr', 'crew'].map((id, i) => (
          <div key={id} className="od-tile" style={{ '--i': i }}>
            <span className="od-name"><Icon name={MODULES[id].icon} size={14} />{t(`office.mod.${id}`)}</span>
            <span className="od-num">{t(`office.mod.${id}.n`)}<em>{t(`office.mod.${id}.unit`)}</em></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 직무에 맞게 — 직무 칩을 고르면(또는 5초마다) 모듈 네 칸이 그 직무의 조합으로 바뀐다 ── */

export const ROLES = [
  { id: 'sales', mods: ['mail', 'msgr', 'crew', 'translate'] },
  { id: 'marketing', mods: ['pages', 'msgr', 'crew', 'mail'] },
  { id: 'ops', mods: ['msgr', 'pages', 'mail', 'crew'] },
  { id: 'ceo', mods: ['approve', 'msgr', 'mail', 'pages'] },
];

export function RoleBoard({ ms = 5000 }) {
  const { t } = useLang();
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const [hover, setHover] = useState(false);
  const [inView, setInView] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || hover || !inView || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const id = setTimeout(() => setActive((a) => (a + 1) % ROLES.length), ms);
    return () => clearTimeout(id);
  }, [active, auto, hover, inView, ms]);

  const role = ROLES[active];
  return (
    <div className="role-board" ref={root} onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)} onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}>
      <div className="role-tabs" role="tablist" aria-label={t('office.role.kicker')}>
        {ROLES.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`role-tab${i === active ? ' on' : ''}`}
            onClick={() => { setActive(i); setAuto(false); }}
          >
            {t(`office.role.${r.id}`)}
          </button>
        ))}
        <span className="role-note">{t(`office.role.${role.id}.b`)}</span>
      </div>
      <div className="role-mods" role="tabpanel" key={role.id}>
        {role.mods.map((id, i) => (
          <Module key={id} id={id} className="role-mod" style={{ '--i': i }} />
        ))}
      </div>
    </div>
  );
}

/* ── 크루에게 맡기기 — 버튼을 누르면 크루가 회신 초안을 쓰고, 보내기는 사람이 한다 ── */

const JUNO = { shape: 0, color: 3, eyes: 0, spot: 0 };
const DRAFT = ['d1', 'd2', 'd3'];

export function CrewDraft() {
  const { t } = useLang();
  // 0 대기 · 1 크루가 읽는 중 · 2~4 초안 한 줄씩 · 5 끝
  const [step, setStep] = useState(0);
  const played = useRef(false);
  const timers = useRef([]);
  const root = useRef(null);

  const run = () => {
    timers.current.forEach(clearTimeout);
    played.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setStep(5); return; }
    setStep(1);
    timers.current = [1200, 2000, 2800, 3700].map((ms, i) => setTimeout(() => setStep(i + 2), ms));
  };

  // 버튼을 누르지 않고 지나가는 사람에게도 한 번은 보여 준다(화면에 절반 이상 들어오면 자동 재생 한 번).
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { io.disconnect(); timers.current.push(setTimeout(() => { if (!played.current) run(); }, 900)); }
    }, { threshold: 0.5 });
    io.observe(root.current);
    return () => { io.disconnect(); timers.current.forEach(clearTimeout); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = step > 0 && step < 5;
  return (
    <div className="crew-draft" ref={root}>
      <div className="cd-mail">
        <div className="cd-head">
          <span className="cd-from"><Icon name="mail" size={14} />{t('office.ax.mail.from')}</span>
          <span className="cd-time">{t('office.mod.mail.m1')}</span>
        </div>
        <p className="cd-subj">{t('office.ax.mail.subj')}</p>
        <p className="cd-body">{t('office.ax.mail.body')}</p>
        <div className="cd-actions">
          <button type="button" className={`fam-btn cd-hand${busy ? ' busy' : ''}`} onClick={run} disabled={busy}>
            <Icon name="handoff" size={14} />
            {step === 5 ? t('office.ax.again') : t('office.ax.btn')}
          </button>
        </div>
      </div>

      <div className={`cd-draft${step > 0 ? ' on' : ''}`} aria-live="polite">
        <div className="cd-crew">
          <CrewFace id="juno" pick={JUNO} state={step >= 5 ? 'done' : step > 0 ? 'work' : 'idle'} size={30} />
          <span>{step >= 5 ? t('office.ax.done') : step > 0 ? t('office.ax.working') : t('office.ax.idle')}</span>
        </div>
        <div className="cd-paper">
          <span className="cd-cap">{t('office.ax.draft')}</span>
          {DRAFT.map((k, i) => (
            <p key={k} className={`cd-line${step >= i + 2 ? ' in' : ''}`}>{t(`office.ax.${k}`)}</p>
          ))}
          {step === 1 && <span className="tf-dots"><i /><i /><i /></span>}
        </div>
        <div className={`cd-foot${step >= 5 ? ' in' : ''}`}>
          <span className="cd-count">
            <Icon name="handoff" size={13} />
            {t('office.mod.crew')} · <b>{step >= 5 ? 4 : 3}</b> {t('office.mod.crew.unit')}
          </span>
          <span className="cd-send">{t('office.ax.send')}</span>
        </div>
      </div>
    </div>
  );
}
