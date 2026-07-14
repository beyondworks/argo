'use client';

// 항해 성도(星圖) 그리드 — 나침반 방위선 + 아스트롤라베 원 + 별자리 클러스터.
// 아르고 로고(나침반 별)에서 파생한 고유 배경 모티프 (표지용 헤어라인).
const CX = 809;
const CY = 500;

// 16방위 럼라인 — SSR/CSR 부동소수점 불일치 방지를 위해 좌표를 반올림
const R2 = (n) => Math.round(n * 100) / 100;
const RAYS = Array.from({ length: 16 }, (_, i) => {
  const a = (i * Math.PI) / 8;
  return {
    x1: R2(CX - Math.cos(a) * 1200),
    y1: R2(CY - Math.sin(a) * 1200),
    x2: R2(CX + Math.cos(a) * 1200),
    y2: R2(CY + Math.sin(a) * 1200),
    major: i % 4 === 0,
  };
});

// 모서리 별자리 클러스터 (점 + 연결선)
const CLUSTERS = [
  [[120, 130], [210, 90], [300, 150], [360, 80], [455, 120]],
  [[1290, 110], [1380, 170], [1470, 120], [1530, 210]],
  [[130, 830], [220, 880], [330, 840], [400, 920]],
  [[1240, 880], [1350, 830], [1450, 890], [1540, 850]],
];

export default function ChartGrid({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1618 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <g fill="none" stroke="var(--fg)">
        {/* 아스트롤라베 동심원 */}
        {[220, 340, 470].map((r) => (
          <circle key={r} cx={CX} cy={CY} r={r} strokeOpacity="0.1" strokeWidth="1" />
        ))}
        <circle cx={CX} cy={CY} r={470} strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 7" />

        {/* 럼라인 */}
        {RAYS.map((r, i) => (
          <line
            key={i}
            x1={r.x1}
            y1={r.y1}
            x2={r.x2}
            y2={r.y2}
            strokeOpacity={r.major ? 0.12 : 0.05}
            strokeWidth="1"
          />
        ))}
      </g>

      {/* 별자리 클러스터 */}
      {CLUSTERS.map((pts, ci) => (
        <g key={ci}>
          <polyline
            points={pts.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="var(--fg)"
            strokeOpacity="0.16"
            strokeWidth="1"
          />
          {pts.map(([x, y], pi) => (
            <circle key={pi} cx={x} cy={y} r="2.4" fill="var(--fg)" opacity="0.35" />
          ))}
        </g>
      ))}
    </svg>
  );
}
