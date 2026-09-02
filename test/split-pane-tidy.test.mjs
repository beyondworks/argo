// 옆에 열기(분할 패널) 정돈 — 유건 실사용 지적(2026-09-02): ① 패널 헤더의 '→'(전체 화면)와 '✕'가 기능 중복으로
// 보여 ✕만 남긴다 ② 주 화면 헤더처럼 크루명 우측에 역할 텍스트 ③ 임베드 채팅의 세션·카드·새 대화 뱃지 줄 제거
// ④ 패널 컴포저(입력창·폴더/클립·프로바이더 줄)의 바닥을 주 화면과 한 선에(실측: .split-chat 하단 패딩 10px일 때
// 패널 줄이 8px 아래 — 주 화면 줄 바닥은 뷰포트 바닥에서 18px 위(.chat-cols top 82 + calc(100vh − 100px))).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));

test('패널 헤더: ✕만 남고 →(전체 화면) 링크는 없다, 크루명 옆 역할(subtitle) 표시', async () => {
  const src = stripComments(await read('../app/c/[ws]/split-pane.jsx'));
  const head = src.slice(src.indexOf('<div className="split-head">'), src.indexOf('<div className="split-body">'));
  assert.doesNotMatch(head, /split\.openFull|name="arrow"|<Link/, '→ 버튼(전체 화면 링크)이 헤더에 남아 있다 — 닫기와 중복');
  assert.match(head, /<span className="split-title" title=\{title\}>\{title\}<\/span>\s*\n\s*\{subtitle && \(\s*\n\s*<span className="nav-sub" title=\{subtitle\} style=\{\{ maxWidth: 180, minWidth: 0,[^\n]*>\{subtitle\}<\/span>/,
    '역할 텍스트가 크루명 바로 우측(nav-sub·말줄임)에 있고 폭 상한 180 — 없으면 flex가 자연폭 비례로 줄여 좁은 패널(360)에서 크루명이 1자만 남는다(검수 MEDIUM-1 실측)');
  assert.match(head, /onClick=\{onClose\}[^\n]*>✕<\/button>/, '닫기 버튼');
  assert.match(src, /export function SplitPane\(\{ ws, side, sideStr, title, subtitle, onClose \}\)/, 'subtitle prop');
  const layout = stripComments(await read('../app/c/[ws]/layout.jsx'));
  assert.match(layout, /subtitle=\{side\.type === 'crew' \? \(agents\.find\(\(a\) => a\.slug === side\.key\)\?\.role \|\| ''\) : ''\}/,
    '레이아웃이 크루 역할을 subtitle로 넘긴다(문서 패널은 빈 값)');
});

test('임베드 채팅: 밴드(역할·세션 뱃지·카드·새 대화)를 그리지 않는다 — 주 화면 밴드는 그대로', async () => {
  const page = stripComments(await read('../app/c/[ws]/crew/[slug]/page.jsx'));
  const bi = page.indexOf('<div className="crew-phone-band"');
  assert.ok(bi > 0, '주 화면 밴드');
  assert.match(page.slice(bi - 40, bi), /\{!embedded && \(\s*$/, '밴드 전체가 !embedded 조건 안에 있어야 한다');
  const band = page.slice(bi, page.indexOf('<div className="thread"', bi));
  assert.match(band, /<\/div>\s*\n\s*\)\}\s*$/, '조건 블록이 밴드 끝에서 닫힌다');
  assert.doesNotMatch(band, /embedded \? \{ display: 'flex' \}/, '임베드 인라인 표시 분기가 남아 있으면 안 된다');
});

test('패널 컴포저 바닥: .split-chat 하단 패딩 18px(주 화면 줄과 한 선) — 다른 규칙이 덮지 않는다', async () => {
  const css = await read('../app/globals.css');
  const rules = [...css.matchAll(/\.split-body\s*>\s*\.split-chat\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 1, '.split-body > .split-chat 규칙은 하나여야 한다(뒤 규칙이 패딩을 덮으면 정렬이 깨진다)');
  assert.match(rules[0], /padding:\s*10px 12px 18px;/, '하단 18px(10px이면 패널 줄이 주 화면보다 8px 아래 — 실측)·상단 10px(밴드가 빠진 자리의 완충)');
  assert.doesNotMatch(css.replace(rules[0], ''), /\.split-chat[^{]*\{[^}]*padding/, '다른 .split-chat 규칙의 padding 금지');
});
