import { useLayoutEffect, useRef, useState } from 'react';

/** 카드 폭에 맞춰 그리는 SVG 그래프. svg: SVG에 붙일 속성(마우스 따라가기 등), overlay: 그래프 위에 겹치는 HTML(값 풍선) */
export function ResponsiveChart({ label, height = 220, children, svg, overlay }) {
  const frame = useRef(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const measure = () => {
      const next = frame.current?.clientWidth ?? 0;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={frame} className="biz-chart-frame"><svg className="biz-chart" style={{ height, maxHeight: 'none' }} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} {...svg}>
    <title>{label}</title>{children(width, height)}
  </svg>{overlay?.(width, height)}</div>;
}
