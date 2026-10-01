// 크루 얼굴 — 메신저와 같은 그림(유건 확정 시안 2026-10-01: 도형 12종·색 12색·표정). 모양·색·표정은 메신저 crew-face.mjs를 그대로 쓴다
// (faceStill = 상수로만 만든 SVG 문자열 — 색·선이 속성에 들어 있어 오피스 CSS가 따로 필요 없다).
// 오피스는 공식적인 화면이라 몸짓·상태 표정은 넣지 않는다(쉼 표정의 정지 얼굴).
// 그림 정의는 첫 화면 묶음 밖에서 받는다(첫 화면 JS 150KB 상한, 검수 #789) — 앱이 뜨자마자 받기 시작하고, 받기 전에는 같은 크기의 빈 칸이라
// 자리가 밀리지 않는다. 크루 목록도 서버에서 늦게 오므로 실제로 빈 칸이 보이는 때는 거의 없다.
import { useSyncExternalStore } from 'react';
import { getState } from '../core/store.js';

let art = null;
const subs = new Set();
import('@msgr/crew-face').then((m) => { art = m; for (const f of subs) f(); }, () => {}); // 받기 실패면 빈 칸(얼굴 없이)으로 둔다
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => art;

export function Face({ id, size = 20, dim = false }) {
  const m = useSyncExternalStore(subscribe, snapshot, snapshot);
  const html = m ? m.faceStill(m.faceOf(id, getState().crews?.find((c) => c.id === id)?.face ?? null), { px: size }) : '';
  return (
    <svg className="face" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={dim ? { opacity: 0.45 } : undefined}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
