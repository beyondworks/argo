// 폴더 보기(유건 9/30) — 기록 화면 네 개(산출물·일지·결정·결재)가 같은 틀을 쓴다.
// 왼쪽 = 폴더(전체 + 에이전트별 + 사람, 최근 활동순), 오른쪽 = 고른 폴더의 항목을 날짜 구간으로. 폰 폭에서는 폴더가 위쪽 가로 칩 줄.
// 고른 폴더는 주소(?folder=)에 남긴다 — 새로고침·뒤로 가기에도 그대로. 묶기 규칙(순수 함수)은 core/board.js.
import { useEffect, useMemo, useRef } from 'react';
import { Face } from './Face.jsx';
import { Icon } from './Icon.jsx';
import { t, getLang } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { crewName } from '../core/store.js';
import { HUMAN, folderize } from '../core/board.js';

/** 지금 주소의 쿼리 일부만 바꾼 주소(null·''은 뺀다) — ?folder=와 ?open=이 서로를 지우지 않게 */
export function withQuery(patch) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
  const s = q.toString();
  return location.pathname + (s ? `?${s}` : '');
}
export const openItem = (id) => navigate(withQuery({ open: id }));
export const closeItem = () => navigate(withQuery({ open: null }));
export const pickFolder = (id) => navigate(withQuery({ folder: id === 'all' ? null : id, open: null }));

/** rows를 폴더로 — key·at은 모듈 수준 함수(매번 새로 만들지 않는 것)를 넘긴다. 없는 폴더를 주소로 받으면 전체로 */
export function useFolder(rows, key, at, folder) {
  return useMemo(() => {
    const folders = folderize(rows, key, at);
    const current = folder && folders.some((f) => f.id === folder) ? folder : 'all';
    const visible = (current === 'all' ? rows : rows.filter((x) => key(x) === current)).slice().sort((a, b) => (at(b) || 0) - (at(a) || 0));
    return { folders, current, visible };
  }, [rows, key, at, folder]);
}

/** 폴더 이름 — 에이전트 이름, 지운 에이전트는 기록에 남은 이름, 사람 폴더는 화면마다 뜻이 맞는 이름 */
export const folderName = (id, human, fallback) => id === HUMAN ? t(human) : crewName(id) || (id.startsWith('name:') ? id.slice(5) : fallback || t('fold.agent'));

export function FolderIcon({ id, size = 20 }) {
  if (id === HUMAN) return <span className="fold-ico" style={{ width: size, height: size }}><Icon name="person" size={Math.round(size * 0.7)} /></span>;
  return <Face id={id.startsWith('name:') ? id.slice(5) : id} size={size} />;
}

export function FolderView({ folders, current, total, human, toolbar, children }) {
  const nav = useRef(null);
  useEffect(() => { // 폰 폭 칩 줄: 고른 폴더가 화면 밖이면 보이게 가로로만 민다(세로 스크롤은 건드리지 않는다)
    const n = nav.current, on = n?.querySelector('.fold-item.on');
    if (!n || !on || n.scrollWidth <= n.clientWidth) return;
    const a = on.getBoundingClientRect(), b = n.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) n.scrollLeft += a.left - b.left - 16;
  }, [current]);
  return (
    <div className="fold">
      <nav ref={nav} className="fold-nav" aria-label={t('fold.folders')}>
        <button type="button" className={`fold-item${current === 'all' ? ' on' : ''}`} aria-current={current === 'all' ? 'true' : undefined} onClick={() => pickFolder('all')}>
          <span className="fold-ico"><Icon name="layout" size={14} /></span><span className="fold-name">{t('fold.all')}</span><small className="fold-n">{total}</small>
        </button>
        {folders.map((f) => (
          <button key={f.id} type="button" className={`fold-item${current === f.id ? ' on' : ''}`} aria-current={current === f.id ? 'true' : undefined} onClick={() => pickFolder(f.id)}>
            <FolderIcon id={f.id} /><span className="fold-name">{folderName(f.id, human, f.latest?.name)}</span><small className="fold-n">{f.n}</small>
          </button>))}
      </nav>
      <div className="fold-main">{toolbar}{children}</div>
    </div>
  );
}

/** 건수 — 영어는 1건일 때 단수 */
export const countText = (n) => t(n === 1 ? 'fold.count1' : 'fold.count', { n });

const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
/** 구간 이름 — 오늘·어제·이번 주·이번 달, 그 이전은 "2026년 8월" */
export function bucketLabel(key) {
  if (!key.startsWith('m:')) return t(`fold.${key}`);
  return new Date(`${key.slice(2)}-01T00:00:00Z`).toLocaleDateString(locale(), { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** 줄 오른쪽 시각 — 오늘·어제 구간은 시:분, 그 밖은 날짜와 시:분(한국 시각) */
export function when(ms, bucket) {
  if (!ms) return '';
  const d = new Date(ms), tz = { timeZone: 'Asia/Seoul', hour12: false };
  const hm = d.toLocaleTimeString(locale(), { ...tz, hour: '2-digit', minute: '2-digit' });
  if (bucket === 'today' || bucket === 'yesterday') return hm;
  return `${d.toLocaleDateString(locale(), { ...tz, month: 'short', day: 'numeric' })} ${hm}`;
}

/** 날짜 구간 머리(이름 + 건수)와 그 아래 줄들 */
export function DateSections({ groups, render }) {
  return groups.map((g) => (
    <section key={g.key} className="fold-sec">
      <h2 className="fold-h">{bucketLabel(g.key)} <span className="dim">· {countText(g.count ?? g.items.length)}</span></h2>
      <div className="fold-rows">{render(g)}</div>
    </section>
  ));
}
