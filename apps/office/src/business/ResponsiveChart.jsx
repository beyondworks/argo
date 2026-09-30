import { useLayoutEffect, useRef, useState } from 'react';
import { horizontalBarGeometry } from './chart-geometry.js';

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

export function HorizontalBarChart({ label, rows, low, high, formatValue, unnamed }) {
  return <div className="biz-chart-scroll"><ResponsiveChart label={label} height={Math.max(120, rows.length * 46 + 12)}>{(width) => rows.map((row, index) => {
    const value = Number(row.sales), bar = horizontalBarGeometry(value, low, high, width);
    const name = row.name || unnamed, amount = formatValue(value), y = index * 46 + 16;
    const nameLimit = Math.max(4, Math.floor((width - amount.length * 8 - 24) / 12));
    const visibleName = name.length > nameLimit ? `${name.slice(0, nameLimit)}…` : name;
    return <g key={row.id ?? 'unattributed'}><title>{`${name}: ${amount}`}</title>
      <text className="name" x="0" y={y}>{visibleName}</text><text x={width} y={y} textAnchor="end">{amount}</text>
      <line className="biz-chart-axis" x1="0" x2={width} y1={y + 14} y2={y + 14} />
      <rect className="biz-chart-bar" x={bar.x} y={y + 7} width={bar.width} height="14" rx="2" />
      <line className="biz-chart-axis" x1={bar.baseline} x2={bar.baseline} y1={y + 4} y2={y + 24} />
    </g>;
  })}</ResponsiveChart></div>;
}
