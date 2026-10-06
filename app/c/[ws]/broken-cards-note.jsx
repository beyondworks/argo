'use client';
// 사이드바의 '크루 카드 N개를 읽지 못했어요' 안내(L2, 2차 L7) — 누르면 펼쳐진다: 어느 파일인지(agents/<이름>.md)·무엇을 하면 되는지·'다시 읽기'.
// <p title>은 키보드·터치로 이름을 볼 수 없고 다음 행동이 없었다. 일시 실패(파일이 잠겨 있음 등)면 다시 읽기로 크루가 돌아온다.
import { useState } from 'react';
import { useLang } from '../../i18n';
import { Spinner } from '../../ui';
import { brokenCardFiles } from './company-load.mjs';

export default function BrokenCardsNote({ broken, onRetry }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { files, more } = brokenCardFiles(broken);
  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try { await onRetry?.(); } finally { setTimeout(() => setRetrying(false), 600); } // 다시 읽은 결과가 오면 안내가 사라지거나 그대로다 — 눌렸다는 것만 잠깐 보인다
  }
  return (
    <div style={{ margin: '4px 12px 8px', fontSize: 11.5, lineHeight: 1.4 }}>
      <button type="button" aria-expanded={open} aria-controls="argo-broken-cards" onClick={() => setOpen((v) => !v)}
        style={{ all: 'unset', cursor: 'pointer', color: 'var(--warn)', display: 'flex', gap: 5, alignItems: 'center', width: '100%', boxSizing: 'border-box' }}>
        <span aria-hidden="true" style={{ display: 'inline-block', fontSize: 8, transition: 'transform 0.16s cubic-bezier(0.23, 1, 0.32, 1)', transform: open ? 'none' : 'rotate(-90deg)' }}>▾</span>
        <span style={{ minWidth: 0 }}>{t('nav.brokenCards', { n: broken.count })}</span>
      </button>
      {open && (
        <div id="argo-broken-cards" role="group" style={{ marginTop: 6, color: 'var(--fg-2)', display: 'grid', gap: 6 }}>
          <span>{t('nav.brokenCardsHelp')}</span>
          <ul className="mono" style={{ margin: 0, paddingLeft: 16, fontSize: 11, overflowWrap: 'anywhere' }}>
            {files.map((f) => <li key={f}>{f}</li>)}
            {more > 0 && <li style={{ listStyle: 'none', marginLeft: -16 }}>{t('nav.brokenCardsMore', { n: more })}</li>}
          </ul>
          <button type="button" className="btn sm" style={{ justifySelf: 'start' }} disabled={retrying} onClick={retry}>
            {retrying ? <Spinner size={11} /> : t('nav.brokenCardsRetry')}
          </button>
        </div>
      )}
    </div>
  );
}
