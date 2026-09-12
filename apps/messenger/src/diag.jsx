// 앱 최상위 오류 표시(유건 제보 2026-09-12: 알림 배너를 눌러 들어가니 빈 화면). 빈 베이지 화면 대신 무엇이 죽었는지 보여 주고
// 다시 열기를 준다. 전역 오류·거부된 프라미스는 localStorage 'msgr-diag'에 최근 20건을 남긴다(설정 → 진단에서 본다).
import { Component } from 'react';

const KEY = 'msgr-diag';
export function readDiag() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
export function pushDiag(kind, message, extra = '') {
  try {
    const list = readDiag(); list.unshift({ at: new Date().toISOString(), kind, message: String(message).slice(0, 400), extra: String(extra).slice(0, 600) });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch { /* 저장 불가 환경 */ }
}
export function clearDiag() { try { localStorage.removeItem(KEY); } catch { /* 무해 */ } }
if (typeof window !== 'undefined' && !window.__msgrDiag) {
  window.__msgrDiag = true;
  window.addEventListener('error', (e) => pushDiag('error', e?.message || e?.error?.message || 'error', e?.error?.stack || `${e?.filename ?? ''}:${e?.lineno ?? ''}`));
  window.addEventListener('unhandledrejection', (e) => pushDiag('rejection', e?.reason?.message || e?.reason || 'rejection', e?.reason?.stack || ''));
}

export class RootBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { pushDiag('render', err?.message || err, `${err?.stack || ''}\n${info?.componentStack || ''}`); }
  render() {
    if (!this.state.err) return this.props.children;
    const msg = String(this.state.err?.message || this.state.err);
    return (
      <div role="alert" style={{ padding: 'max(24px, env(safe-area-inset-top)) 20px 20px', fontFamily: 'system-ui, sans-serif', color: '#1a1a1a' }}>
        <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>앱을 그리는 중 오류가 났습니다</p>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 14px', overflowWrap: 'anywhere' }}>{msg}</p>
        <button type="button" onClick={() => location.reload()} style={{ font: 'inherit', padding: '10px 16px', borderRadius: 999, border: '1px solid #ccc', background: '#fff' }}>다시 열기</button>
      </div>
    );
  }
}
