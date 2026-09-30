import { useLayoutEffect, useRef, useState } from 'react';

export function ResponsiveChart({ label, height = 220, children }) {
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
  return <div ref={frame} className="biz-chart-frame"><svg className="biz-chart" style={{ height, maxHeight: 'none' }} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <title>{label}</title>{children(width, height)}
  </svg></div>;
}
