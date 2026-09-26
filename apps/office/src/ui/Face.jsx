// 크루 얼굴 — 메신저와 같은 규칙(평면 단색 도형 + 작은 눈, 입 없음). 모양·색 계산은 메신저 crew-face.mjs를 그대로 쓴다.
// 오피스는 공식적인 화면이라 대기 애니메이션은 넣지 않는다(정지 얼굴).
import { faceOf, faceGeometry } from '@msgr/crew-face';

export function Face({ id, size = 20, dim = false }) {
  const g = faceGeometry(faceOf(id));
  const eye = g.eyes === 'stroke'
    ? <><path d={`M${g.L - 3} ${g.cy}h6M${g.R - 3} ${g.cy}h6`} stroke="#1f1e1b" strokeWidth="4" strokeLinecap="round" /></>
    : g.eyes === 'bean'
      ? <><ellipse cx={g.L} cy={g.cy} rx="3.4" ry="5.2" fill="#1f1e1b" /><ellipse cx={g.R} cy={g.cy} rx="3.4" ry="5.2" fill="#1f1e1b" /></>
      : <><circle cx={g.L} cy={g.cy} r="4.4" fill="#1f1e1b" /><circle cx={g.R} cy={g.cy} r="4.4" fill="#1f1e1b" /></>;
  return (
    <svg className="face" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={dim ? { opacity: 0.45 } : undefined}>
      <path d={g.d} fill={g.color} />{eye}
    </svg>
  );
}
