'use client';

import { faceGeometry, faceMotion } from '@/lib/crewFace';

// 앱의 CrewFace와 같은 그림 — 상태: idle(깜빡임·두리번·갸웃·하품) · work(두리번) · done(^^ 통통) · surprise(1초 놀람).
function Eye({ eyes, x, y }) {
  if (eyes === 'stroke') return <path d={`M${x - 0.6} ${y - 5}q1.2 5 .4 10`} className="stroke" />;
  if (eyes === 'bean') return <ellipse cx={x} cy={y} rx="3.5" ry="5.4" />;
  return <circle cx={x} cy={y} r="4.2" />;
}

export default function CrewFace({ id, pick, state = 'idle', size = 32 }) {
  const g = faceGeometry(id, pick);
  const m = faceMotion(id);
  const { L, R, cy } = g;
  const eyes = (
    <>
      <Eye eyes={g.eyes} x={L} y={cy} />
      <Eye eyes={g.eyes} x={R} y={cy} />
    </>
  );
  return (
    <svg
      className={`crew-face s-${state}${state === 'idle' ? ` idle-${m.variant}` : ''}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ '--face-dur': m.duration, '--face-delay': m.delay }}
    >
      <g className="rig">
        <path className="body" d={g.d} fill={g.color} />
        <g className="face">
          {state === 'done' ? (
            <g className="line">
              <path d={`M${L - 4.5} ${cy + 2}q4.5-7 9 0`} />
              <path d={`M${R - 4.5} ${cy + 2}q4.5-7 9 0`} />
            </g>
          ) : (
            <g className={state === 'surprise' ? 'surprise' : 'blink'}>{eyes}</g>
          )}
        </g>
      </g>
    </svg>
  );
}
