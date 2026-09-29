'use client';

// i18n 문자열의 *별표* 마킹을 세리프 이탤릭 액센트로 렌더 — Ren*ai*ssance 문법
export default function Accent({ text }) {
  const parts = String(text).split(/\*([^*]+)\*/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <em key={i} className="serif-accent">
            {part}
          </em>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
