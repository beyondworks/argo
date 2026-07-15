'use client';

import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

// 문서/정책 페이지 공용 셸 — 스냅 스크롤 없는 일반 문서 레이아웃.
export default function DocShell({ kicker, title, updated, children }) {
  return (
    <main className="doc-main">
      <Nav />
      <article className="doc">
        <header className="doc-head">
          {kicker && <span className="mono-label doc-kicker">{kicker}</span>}
          <h1 className="doc-title">{title}</h1>
          {updated && <span className="mono-label mono-dim doc-updated">{updated}</span>}
        </header>
        <div className="doc-body">{children}</div>
      </article>
      <Footer />
    </main>
  );
}
