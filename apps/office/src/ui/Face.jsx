// 크루 얼굴 — 메신저와 같은 그림(유건 확정 시안 2026-10-01: 도형 12종·색 12색·표정). 모양·색·표정은 메신저 crew-face.mjs를 그대로 쓴다
// (faceInner = 상수로만 만든 SVG 문자열 — 색·선이 속성에 들어 있어 오피스 CSS가 따로 필요 없다).
// 오피스는 공식적인 화면이라 몸짓·상태 표정은 넣지 않는다(쉼 표정의 정지 얼굴).
import { faceOf, faceInner } from '@msgr/crew-face';
import { getState } from '../core/store.js';

export function Face({ id, size = 20, dim = false }) {
  const face = faceOf(id, getState().crews?.find((c) => c.id === id)?.face ?? null);
  return (
    <svg className="face" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={dim ? { opacity: 0.45 } : undefined}
      dangerouslySetInnerHTML={{ __html: faceInner(face, { px: size }) }} />
  );
}
