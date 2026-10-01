import { useLayoutEffect, useRef, useState } from 'react';

/** 카드 폭에 맞춰 그리는 SVG 그래프. svg: SVG에 붙일 속성(마우스 따라가기 등), overlay: 그래프 위에 겹치는 HTML(값 풍선)
 *  모듈 높이를 정한 카드(.sized-h, 유건 10/1 가장자리 끌기)에서는 남는 높이를 그래프가 채운다 — 그 높이도 같이 잰다 */
export function ResponsiveChart({ label, height: base = 220, children, svg, overlay }) {
  const frame = useRef(null);
  const [size, setSize] = useState({ width: 320, height: base });
  useLayoutEffect(() => {
    const measure = () => {
      const el = frame.current;
      if (!el?.clientWidth) return;
      const next = { width: el.clientWidth, height: el.closest('.sized-h') ? Math.max(120, el.clientHeight) : base };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [base]);
  const { width, height } = size;
  return <div ref={frame} className="biz-chart-frame"><svg className="biz-chart" style={{ height, maxHeight: 'none' }} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} {...svg}>
    <title>{label}</title>{children(width, height)}
  </svg>{overlay?.(width, height)}</div>;
}
