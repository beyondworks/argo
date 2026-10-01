'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/lib/gsap';
import { FACES } from '@/components/family/MsgrScenes';
import { useLang } from '@/lib/i18n';
import CrewFace from '@/components/family/CrewFace';
import Icon from '@/components/family/Icon';
import Accent from '@/components/Accent';

// 직무판 — 오피스 앱 화면 하나에서 직무 칩을 바꾸면 모듈이 자리·크기를 바꿔 다시 조립된다(티저 BY ROLE과 같은 동작).
// 모듈은 모양이 다 다르다(목록·번역 쌍·진행 막대·말풍선·큰 숫자·체크리스트·그래프·할 일) — 내용만 바뀌면 바뀐 티가 안 난다(9/30 유건).
// 배치는 6칸 격자의 [칸 수, 줄 수]를 순서대로 — 빈칸 없이 흘러 들어간다(좁은 화면은 3칸 → 2칸으로 반씩).
export const ROLES = [
  // 6칸 × 3줄 — [모듈, 칸 수, 줄 수]를 순서대로 흘려 넣는다(판은 디스플레이 비율 16:10)
  { id: 'sales', mods: [['mail', 4, 2], ['translate', 2, 1], ['approve', 2, 1], ['crew', 3, 1], ['msgr', 3, 1]] },
  { id: 'marketing', mods: [['pages', 3, 2], ['metrics', 3, 1], ['msgr', 3, 1], ['crew', 2, 1], ['mail', 4, 1]] },
  { id: 'ops', mods: [['msgr', 2, 3], ['pages', 4, 1], ['todos', 2, 2], ['approve', 2, 1], ['crew', 2, 1]] },
  { id: 'ceo', mods: [['approve', 2, 2], ['metrics', 4, 2], ['mail', 2, 1], ['msgr', 2, 1], ['todos', 2, 1]] },
];
const ICONS = { mail: 'mail', translate: 'translate', crew: 'handoff', msgr: 'chat', approve: 'stamp', pages: 'page', metrics: 'chart', todos: 'check' };
const AREA = [22, 30, 26, 38, 34, 47, 44, 58, 55, 69, 66, 82];

const Dots = () => <span className="fb-dots"><i /><i /><i /></span>;

// 사람 얼굴(이니셜) — 크루는 CrewFace, 사람은 이니셜 원
const Av = ({ n, tone = 0 }) => <span className={`rb-av t${tone}`}>{n}</span>;
const Trend = ({ down }) => <svg className={`rb-trend${down ? ' down' : ''}`} viewBox="0 0 10 10" aria-hidden="true"><path d={down ? 'M2 3.5l3 3.5 3-3.5z' : 'M2 6.5l3-3.5 3 3.5z'} /></svg>;
const MAIL_AV = ['N', 'A', 'W', 'G', 'I'];

function ModBody({ id, t }) {
  if (id === 'mail') {
    return (
      <ul className="rb-mail">
        {[1, 2, 3, 4, 5].map((n) => {
          const [from, subj] = t(`office.mod.mail.r${n}`).split(' — ');
          return (
            <li key={n} className={n <= 2 ? 'unread' : ''}>
              <Av n={MAIL_AV[n - 1]} tone={n % 5} />
              <div className="tx">
                <div className="l1"><b>{from}</b>{n === 1 && <Icon name="clip" size={12} />}<span className="meta">{t(`office.mod.mail.m${n}`)}</span></div>
                <div className="l2">{subj}</div>
                <div className="l3">{t(`office.mod.mail.p${n}`)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  if (id === 'translate') {
    return (
      <ul className="rb-tr">
        {[[1, 'EN', 64], [2, 'JA', 100]].map(([n, to, pct]) => (
          <li key={n}>
            <span className="rb-file"><Icon name="page" size={14} /></span>
            <div className="tx">
              <b>{t(`office.mod.translate.r${n}`)}</b>
              <span className="meta"><span className="lang">KO<Icon name="arrow" size={10} />{to}</span>{pct < 100 ? `${t('office.mod.translate.s1')} · ${pct}%` : <><Icon name="check" size={11} />{t('office.mod.translate.m2')}</>}</span>
              <span className={`prog${pct === 100 ? ' done' : ''}`}><i style={{ width: `${pct}%` }} /></span>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (id === 'crew') {
    return (
      <ul className="rb-cw">
        {[['juno', 1, 62, 'draft'], ['atlas', 2, 84, 'tr'], ['sage', 3, 35, 'idle']].map(([f, n, pct, st]) => (
          <li key={f}>
            <CrewFace id={`rb-${f}`} pick={FACES[f]} state="work" size={26} />
            <div className="tx">
              <b>{t(`office.mod.crew.r${n}`)}</b>
              <span className="meta">{t(`msgr.join.n.${f}`)} · {t(`office.app.st.${st}`)}{st !== 'idle' && <Dots />}</span>
            </div>
            <svg className="rb-ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle className="v" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${pct} 100`} /></svg>
          </li>
        ))}
      </ul>
    );
  }
  if (id === 'msgr') {
    return (
      <div className="rb-ch">
        <div className="ch"><b>#launch</b><span>{t('office.mod.msgr.members')}</span></div>
        <div className="msg"><Av n={t('film.dan').slice(0, 1)} tone={2} /><div><b>{t('film.dan')}<em>09:41</em></b><p>{t('office.mod.msgr.b1')}</p></div></div>
        <div className="msg"><CrewFace id="rb-ch-atlas" pick={FACES.atlas} size={26} /><div><b>{t('film.atlas')}<em>09:44</em></b><p>{t('office.mod.msgr.b2')}</p><span className="pill"><Icon name="stamp" size={11} />{t('office.mod.msgr.n')} {t('office.mod.msgr.unit')}</span></div></div>
        <div className="compose">{t('office.mod.msgr.ph')}</div>
      </div>
    );
  }
  if (id === 'approve') {
    return (
      <div className="rb-ap">
        <div className="hd"><span className="big">{t('office.mod.approve.n')}</span><span className="sub">{t('office.mod.approve.sub')}</span></div>
        <ul>
          {[[1, 'atlas'], [2, 'juno']].map(([n, f]) => (
            <li key={n}>
              <CrewFace id={`rb-ap-${f}`} pick={FACES[f]} size={24} />
              <div className="tx"><b>{t(`office.mod.approve.r${n}`)}</b><span className="meta">{t(`office.mod.approve.from${n}`)} · {t(`office.mod.approve.m${n}`)}</span></div>
              <span className="btn">{t('office.mod.approve.review')}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (id === 'pages') {
    return (
      <div className="rb-doc">
        <div className="cover" />
        <b className="ttl">{t('office.mod.pages.r1')}</b>
        <span className="meta"><span className="stack"><Av n={t('office.app.ini')} tone={0} /><Av n={t('film.dan').slice(0, 1)} tone={2} /></span>{t('office.mod.pages.edited')}</span>
        <ul>
          {[1, 2, 3].map((n) => (
            <li key={n} className={n < 3 ? 'on' : ''}>
              <span className="box">{n < 3 && <Icon name="check" size={10} />}</span>
              <span className="main">{t(`film.slip.r${n}`)}</span>
              <span className="due">{t(`film.slip.d${n}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (id === 'metrics') {
    const pts = AREA.map((v, i) => `${(i / (AREA.length - 1)) * 300},${100 - v}`).join(' ');
    return (
      <div className="rb-kpi">
        <div className="kpis">
          <div><span>{t('office.mod.metrics.k1')}</span><b>1,284</b><em><Trend />12%</em></div>
          <div><span>{t('office.mod.metrics.k2')}</span><b>{t('office.mod.metrics.v2')}</b><em><Trend down />18%</em></div>
          <div className="goal">
            <svg className="rb-ring big" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle className="v" cx="12" cy="12" r="9" pathLength="100" strokeDasharray="87 100" /></svg>
            <span><b>87%</b>{t('office.mod.metrics.cap')}</span>
          </div>
        </div>
        <svg className="area" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="rb-area-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e8e400" stopOpacity="0.55" /><stop offset="1" stopColor="#e8e400" stopOpacity="0" /></linearGradient></defs>
          {[25, 50, 75].map((y) => <line key={y} x1="0" x2="300" y1={y} y2={y} />)}
          <polygon points={`0,100 ${pts} 300,100`} fill="url(#rb-area-g)" />
          <polyline points={pts} />
        </svg>
      </div>
    );
  }
  return (
    <ul className="rb-td">
      {[[1, 0], [2, 1], [3, 2]].map(([n, who]) => (
        <li key={n} className={n === 1 ? 'on' : ''}>
          <span className="box">{n === 1 && <Icon name="check" size={10} />}</span>
          <span className="main">{t(`office.mod.todos.r${n}`)}</span>
          <span className={`due${n === 1 ? ' today' : ''}`}>{t(`office.mod.todos.d${n}`)}</span>
          {who === 0 ? <Av n={t('office.app.ini')} tone={0} /> : <CrewFace id={`rb-td-${n}`} pick={FACES[who === 1 ? 'juno' : 'sage']} size={18} />}
        </li>
      ))}
    </ul>
  );
}

export function RoleBoard({ ms = 5000 }) {
  const { t } = useLang();
  const [active, setActive] = useState(0);
  const [inView, setInView] = useState(false);
  const root = useRef(null);
  const grid = useRef(null);
  const els = useRef(new Map());
  const before = useRef(null); // 바뀌기 직전 모듈 위치(FLIP)

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);

  // 바뀌기 직전: 모든 모듈의 모습을 사본으로 제자리에 남겨 곧바로 흐리게 지운다(빠지는 것은 천천히 가라앉는다).
  // 실제 모듈은 글자를 숨긴 빈 종이로 옛 자리에서 떠올라 새 자리로 날아가 크기를 맞추고, 내려앉으면 줄이 차례로 올라온다.
  // 글자는 늘어난 채로 한 프레임도 보이지 않는다(9/30 유건: "이동될 때 요소 늘어나는 현상").
  const go = (i) => {
    if (i === active) return;
    const snap = new Map();
    els.current.forEach((el, id) => { if (el) snap.set(id, el.getBoundingClientRect()); });
    before.current = snap;
    if (!prefersReducedMotion()) {
      const next = new Set(ROLES[i].mods.map((m) => m[0]));
      const g = grid.current.getBoundingClientRect();
      els.current.forEach((el, id) => {
        if (!el) return;
        const r = snap.get(id);
        const ghost = el.cloneNode(true);
        ghost.classList.add('rb-ghost');
        Object.assign(ghost.style, { position: 'absolute', left: `${r.left - g.left}px`, top: `${r.top - g.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: 0, pointerEvents: 'none', zIndex: 3 });
        grid.current.appendChild(ghost);
        const leaving = !next.has(id);
        ghost.animate(leaving
          ? [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(18px) scale(0.94)', filter: 'blur(6px)' }]
          : [{ opacity: 1 }, { opacity: 0 }], { duration: leaving ? 420 : 170, easing: 'cubic-bezier(0.55,0,0.9,0.45)', fill: 'forwards' }).onfinish = () => ghost.remove();
      });
    }
    setActive(i);
  };

  useLayoutEffect(() => {
    const snap = before.current;
    before.current = null;
    if (!snap || prefersReducedMotion()) return;
    let k = 0;
    els.current.forEach((el, id) => {
      if (!el) return;
      const b = el.getBoundingClientRect();
      const a = snap.get(id);
      const delay = 70 * k++;
      const land = (a ? 760 : 620) + delay;
      // 내려앉은 뒤 머리·줄이 차례로 올라온다
      const parts = [el.querySelector('.o-module-head'), ...el.querySelectorAll('.o-module-body > * > :not(ul), .o-module-body li')].filter(Boolean);
      parts.forEach((p, j) => p.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: land - 120 + j * 45, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'backwards' }));
      if (!a) {
        el.animate([{ opacity: 0, transform: 'translateY(28px) scale(0.92)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 640, delay: 200 + delay, easing: 'cubic-bezier(0.34,1.4,0.64,1)', fill: 'backwards' });
        return;
      }
      const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
      el.animate([
        { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, boxShadow: '0 0 0 rgba(38,36,31,0)' },
        { offset: 0.35, transformOrigin: 'top left', boxShadow: '0 22px 48px rgba(38,36,31,0.16)' },
        { transformOrigin: 'top left', transform: 'none', boxShadow: '0 0 0 rgba(38,36,31,0)' },
      ], { duration: 760, delay, easing: 'cubic-bezier(0.65,0,0.35,1)', fill: 'backwards' });
    });
  }, [active]);

  // 화면에 보이면 5초마다 다음 직무 — 마우스를 올려도 멈추지 않는다(메신저 탭과 같은 규칙)
  useEffect(() => {
    if (!inView || prefersReducedMotion()) return undefined;
    const id = setTimeout(() => go((active + 1) % ROLES.length), ms);
    return () => clearTimeout(id);
  }, [active, inView, ms]); // eslint-disable-line react-hooks/exhaustive-deps

  const role = ROLES[active];
  return (
    <div className="rb" ref={root}>
      <div className="rb-bar" aria-hidden="true"><span className="lights"><i /><i /><i /></span><span className="ttl">{t('office.app.title')}</span></div>
      <aside className="rb-side" aria-hidden="true">
        <div className="rb-ws"><span className="logo">A</span><b>Acme</b><Icon name="chevron" size={14} /></div>
        <div className="rb-search"><Icon name="search" size={13} />{t('office.app.search')}<kbd>⌘K</kbd></div>
        {[['home', 'office.app.home'], ['mail', 'office.mod.mail', '12'], ['page', 'office.mod.pages'], ['stamp', 'film.slip.tag', '2']].map(([ic, k, n], i) => (
          <span key={k} className={`rb-nav${i === 0 ? ' on' : ''}`}><Icon name={ic} size={14} />{t(k)}{n && <em className={ic === 'stamp' ? 'y' : ''}>{n}</em>}</span>
        ))}
        <span className="rb-cap">{t('office.mod.pages')}</span>
        {[1, 2, 3].map((n) => <span key={n} className="rb-nav sm"><Icon name="page" size={13} />{t(`office.mod.pages.r${n}`)}</span>)}
        <span className="rb-cap">{t('office.app.crew')}</span>
        {[['juno', 'draft'], ['atlas', 'tr'], ['sage', 'idle']].map(([f, st]) => (
          <span key={f} className="rb-nav crew"><CrewFace id={`rbs-${f}`} pick={FACES[f]} size={20} /><span className="nm">{t(`msgr.join.n.${f}`)}<small>{t(`office.app.st.${st}`)}</small></span><i className={`live${st === 'idle' ? ' idle' : ''}`} /></span>
        ))}
        <div className="rb-me"><Av n={t('office.app.ini')} tone={0} /><span className="nm">{t('office.app.user')}<small>{t('office.app.userrole')}</small></span></div>
      </aside>
      <div className="rb-main">
        <div className="rb-top">
          <b>{t('office.app.home')}</b><span className="rb-date">{t('office.app.date')}</span>
          <span className="rb-people" aria-hidden="true"><Av n={t('office.app.ini')} tone={0} /><Av n={t('film.dan').slice(0, 1)} tone={2} /><Av n="J" tone={3} /><em>+4</em></span>
          <div className="rb-chips" role="tablist" aria-label={t('office.role.kicker')}>
            {ROLES.map((r, i) => (
              <button key={r.id} type="button" role="tab" aria-selected={i === active} className={`rb-chip${i === active ? ' on' : ''}`} onClick={() => go(i)}>
                {t(`office.role.${r.id}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="rb-note">{t(`office.role.${role.id}.b`)}</p>
        <div className="rb-grid" ref={grid} role="tabpanel">
          {role.mods.map(([id, w, h]) => (
            <article key={id} ref={(el) => (el ? els.current.set(id, el) : els.current.delete(id))} className={`o-module rb-mod rb-m-${id}${id === 'approve' ? ' pending' : ''}`} style={{ '--w': w, '--h': h, '--mw': w >= 3 ? 2 : 1 }}>
              <header className="o-module-head">
                <Icon name={ICONS[id]} size={15} />
                <span className="o-module-title">{t(`office.mod.${id}`)}</span>
                <span className="o-module-all">{t('office.mod.all')}</span>
              </header>
              <div className="o-module-body"><ModBody id={id} t={t} /></div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 기능 벤토 — 카드마다 작은 앱 화면이 시간표대로 되풀이된다(노션 모션처럼 평면 UI 그대로). 화면에 보일 때만 돈다 ──
function useLoop(times, total, run) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!run) return undefined;
    if (prefersReducedMotion()) { setStep(times.length); return undefined; }
    let ids = [];
    const cycle = () => { setStep(0); ids = times.map((ms, i) => setTimeout(() => setStep(i + 1), ms)); ids.push(setTimeout(cycle, total)); };
    cycle();
    return () => ids.forEach(clearTimeout);
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  return step;
}

function PageUI({ t, run }) {
  const s = useLoop([700, 1300, 2100, 2600, 3600], 6200, run);
  const menu = [['page', 'office.feat.menu.h', 'office.feat.menu.hd'], ['check', 'office.feat.menu.todo', 'office.feat.menu.todod'], ['chart', 'office.feat.menu.table', 'office.feat.menu.tabled']];
  return (
    <div className="fb-ui fb-page">
      <div className="cover" />
      <b className="fb-h">{t('office.mod.pages.r1')}</b>
      <span className="meta"><span className="stack"><Av n={t('office.app.ini')} tone={0} /><Av n={t('film.dan').slice(0, 1)} tone={2} /></span>{t('office.mod.pages.edited')}</span>
      {[1, 2].map((n) => <p key={n} className="fb-li on"><span className="box"><Icon name="check" size={9} /></span><span className="main">{t(`film.slip.r${n}`)}</span><span className="due">{t(`film.slip.d${n}`)}</span></p>)}
      {s >= 4 ? <p className={`fb-li new${s >= 5 ? ' on' : ''}`}><span className="box">{s >= 5 && <Icon name="check" size={9} />}</span><span className="main">{t('film.slip.r3')}</span><span className="due">{t('film.slip.d3')}</span></p>
        : <p className="fb-caret">{s >= 1 ? '/' : ''}<i /></p>}
      <div className={`fb-menu${s >= 2 && s < 4 ? ' open' : ''}`}>
        {menu.map(([ic, k, d], i) => (
          <span key={k} className={i === 1 && s >= 3 ? 'hl' : ''}><span className="ic"><Icon name={ic} size={13} /></span><span className="tx"><b>{t(k)}</b><em>{t(d)}</em></span></span>
        ))}
      </div>
    </div>
  );
}

function CrewUI({ t, run }) {
  const s = useLoop([900, 1300, 2100, 2600, 3100, 3700, 4900], 7600, run);
  return (
    <div className="fb-ui fb-crew">
      <div className="fb-mail">
        <Av n="N" tone={1} />
        <div className="tx">
          <span className="l1"><em>{t('office.ax.mail.from')}</em><Icon name="clip" size={12} /><span className="meta">{t('office.mod.mail.m1')}</span></span>
          <b>{t('office.ax.mail.subj')}</b>
          <span className="l3">{t('office.ax.mail.body')}</span>
        </div>
      </div>
      <span className={`fb-btn dark${s >= 1 ? ' press' : ''}`}><Icon name="handoff" size={12} />{t('office.ax.btn')}</span>
      <div className={`fb-draft${s >= 2 ? ' show' : ''}`}>
        <div className="hd"><CrewFace id="fb-juno" pick={FACES.juno} state={s >= 6 ? 'done' : 'work'} size={22} /><b>{t('film.juno')}</b><em>{t('office.ax.draft')}</em></div>
        {s < 3 && <Dots />}
        {['d1', 'd2', 'd3'].map((k, i) => <p key={k} className={s >= 3 + i ? 'on' : ''}>{t(`office.ax.${k}`)}</p>)}
        <span className={`fb-btn${s >= 7 ? ' ok' : ' dark'}${s >= 6 ? ' show' : ''}`}>{s >= 7 ? <><Icon name="check" size={12} />{t('office.ax.sent')}</> : t('office.ax.send')}</span>
      </div>
    </div>
  );
}

function CmdKUI({ t, run }) {
  const s = useLoop([600, 1100, 1500, 1900, 2800], 5600, run);
  const q = t('office.feat.k.q');
  const typed = s >= 2 ? q.slice(0, Math.min(q.length, Math.ceil((q.length * (s - 1)) / 3))) : '';
  return (
    <div className="fb-ui fb-cmdk">
      <div className={`fb-pal${s >= 1 ? ' open' : ''}`}>
        <div className="in"><Icon name="search" size={14} />{typed ? <b>{typed}</b> : <em>{t('office.feat.k.ph')}</em>}<i /><span className="k">⌘K</span></div>
        <span className={`sec${s >= 4 ? ' show' : ''}`}>{t('office.feat.k.sec')}</span>
        {[[1, 'handoff'], [2, 'mail'], [3, 'page']].map(([n, ic]) => (
          <p key={n} className={`${s >= 4 ? 'show' : ''}${s >= 5 && n === 1 ? ' hl' : ''}`} style={{ '--i': n }}>
            <span className="ic"><Icon name={ic} size={13} /></span>{t(`office.feat.k.r${n}`)}{n === 1 && <kbd>Enter</kbd>}
          </p>
        ))}
      </div>
    </div>
  );
}

function TranslateUI({ t, run }) {
  const s = useLoop([900, 1500], 5200, run);
  return (
    <div className="fb-ui fb-tr">
      <div className="hd"><Icon name="mail" size={13} /><b>{t('office.feat.tr.file')}</b><span className={`chip${s >= 1 ? ' on' : ''}`}>KO<Icon name="arrow" size={10} />EN</span></div>
      <p className="src"><span className="lg">KO</span>{t('office.feat.tr.from')}</p>
      <p className={`dst${s >= 2 ? ' on' : ''}`}><span className="lg">EN</span>{t('office.feat.tr.to')}</p>
    </div>
  );
}

function VersionUI({ t, run }) {
  const s = useLoop([1000, 1800, 2500], 5600, run);
  const pick = s >= 1 ? 1 : 0;
  const who = [<Av key="a" n={t('office.app.ini')} tone={0} />, <CrewFace key="j" id="fb-ver-j" pick={FACES.juno} size={18} />, <Av key="d" n={t('film.dan').slice(0, 1)} tone={2} />];
  return (
    <div className="fb-ui fb-ver">
      <div className="vdoc"><b /><i /><i className={s >= 3 ? 'old' : 'cur'} /><i /><i className="short" /></div>
      <ul>
        {['now', 'y', 'd'].map((k, i) => <li key={k} className={i === pick ? 'on' : ''}>{who[i]}<span>{t(`office.feat.v.${k}`)}</span></li>)}
      </ul>
      <span className={`fb-btn dark${s >= 2 ? ' press' : ''}${s >= 1 ? ' show' : ''}`}>{t('office.feat.v.restore')}</span>
    </div>
  );
}

function ApproveUI({ t, run }) {
  const s = useLoop([1500, 1900], 5000, run);
  return (
    <div className={`fb-ui fb-ap${s >= 2 ? ' done' : ''}`}>
      <div className="who"><CrewFace id="fb-ap-a" pick={FACES.atlas} size={22} /><span>{t('office.feat.ap.from')}</span></div>
      <b>{t('film.slip.ask')}</b>
      <span className="meta">{t('office.feat.ap.meta')}</span>
      <div className="acts">
        <span className="fb-btn">{t('office.feat.ap.reject')}</span>
        <span className={`fb-btn${s >= 2 ? ' ok' : ' dark'}${s === 1 ? ' press' : ''}`}>{s >= 2 ? <><Icon name="check" size={12} />{t('film.slip.done')}</> : t('film.slip.btn')}</span>
      </div>
    </div>
  );
}

function SaveUI({ t, run }) {
  const s = useLoop([400, 800, 1200, 1600, 2000, 2400, 3200], 5600, run);
  const txt = t('office.feat.s.text');
  return (
    <div className="fb-ui fb-save">
      <div className="tb"><span className="b">B</span><span className="i">I</span><span className="u">U</span><span className="sep" /><Icon name="check" size={13} /><Icon name="clip" size={13} />
        <span className={`st${s >= 7 ? ' ok' : ''}`}>{s >= 7 ? <><Icon name="check" size={11} />{t('office.feat.s.saved')}</> : s >= 1 ? <><Dots />{t('office.feat.s.saving')}</> : ''}</span>
      </div>
      <b className="t">{t('office.feat.s.doc')}</b>
      <p>{txt.slice(0, Math.round((txt.length * Math.min(s, 5)) / 5))}<i /></p>
    </div>
  );
}

const FEATS = [
  ['page', PageUI, 'office.feat.page.t', 'office.feat.page.b'],
  ['crew', CrewUI, 'office.feat.crew.t', 'office.feat.crew.b'],
  ['cmdk', CmdKUI, 'office.trait.command.t', 'office.trait.command.b'],
  ['tr', TranslateUI, 'office.feat.tr.t', 'office.feat.tr.b'],
  ['ver', VersionUI, 'office.trait.history.t', 'office.trait.history.b'],
  ['ap', ApproveUI, 'office.feat.ap.t', 'office.feat.ap.b'],
  ['save', SaveUI, 'office.trait.save.t', 'office.trait.save.b'],
];

export function FeatureBento() {
  const { t } = useLang();
  const root = useRef(null);
  const [run, setRun] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setRun(e.isIntersecting), { threshold: 0.15 });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);
  return (
    <ul className="fb" ref={root}>
      {FEATS.map(([id, UI, tk, bk], i) => (
        <li key={id} className={`fb-card fb-${id} rise`} style={{ '--d': `${i * 60}ms` }}>
          <div className="fb-stage" aria-hidden="true"><UI t={t} run={run} /></div>
          <h3>{t(tk)}</h3>
          <p>{t(bk)}</p>
        </li>
      ))}
    </ul>
  );
}
