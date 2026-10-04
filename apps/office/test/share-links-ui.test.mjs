// 파일 상세의 '공유 링크' 칸(src/files/ShareLinks.jsx) — 목록을 못 불러온 상태와 권한 없음 안내가 섞이지 않는지(분리 검수 LOW-9).
// 컴포넌트 함수만 꺼내(babel·esbuild) 상태 값을 넣고 그대로 그려 본다 — 사전·아이콘·창은 이름만 찍는 대역.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LINK_DICT } from '../src/files/link-i18n.js';

const src = readFileSync(new URL('../src/files/ShareLinks.jsx', import.meta.url), 'utf8');
const node = parse(src, { sourceType: 'module', plugins: ['jsx'] }).program.body.find((n) => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'ShareLinks').declaration;
const code = transformSync(src.slice(node.start, node.end), { loader: 'jsx', jsx: 'transform', jsxFactory: 'h', jsxFragment: 'F', format: 'cjs' }).code;

/** data: 목록 상태(첫 useState) — 나머지 상태는 처음 값 그대로 */
function render(data) {
  let n = 0;
  const useState = (init) => [n++ === 0 ? data : init, () => {}];
  const Icon = ({ name }) => createElement('i', { 'data-icon': name });
  const Modal = ({ open, children }) => (open ? createElement('div', null, children) : null);
  const ShareLinks = new Function('h', 'F', 'useState', 'useEffect', 't', 'Icon', 'Modal', 'showToast', 'createLink', 'revokeLink', 'listLinks', 'linkDaysLeft', 'LINK_DAYS', 'fileError', 'day',
    `${code}\nreturn ShareLinks;`)(createElement, (p) => p.children, useState, () => {}, (k) => k, Icon, Modal, () => {}, null, null, () => new Promise(() => {}), () => 3, 30, () => '', () => '10월 4일');
  return renderToStaticMarkup(createElement(ShareLinks, { space: 'me', file: { id: 'f1' } }));
}

test('공유 링크 목록을 못 불러오면 "불러오지 못했습니다"와 다시 시도 — 권한 없음·링크 없음 안내는 보이지 않는다', () => {
  const html = render({ can: false, links: [], error: true });
  assert.match(html, /role="alert"[^>]*>.*link\.loadFailed/);
  assert.ok(html.includes('link.retry') && html.includes('data-icon="refresh"'));
  assert.ok(!html.includes('link.noRight'), '실패를 권한 없음으로 보이지 않는다');
  assert.ok(!html.includes('link.none'));
  assert.ok(LINK_DICT['link.loadFailed'][0] && LINK_DICT['link.loadFailed'][1] && LINK_DICT['link.retry'][1], 'ko·en');
});

test('불러온 목록: 권한이 없으면 권한 안내, 있으면 만들기 — 실패 안내는 없다', () => {
  const none = render({ can: false, links: [] });
  assert.ok(none.includes('link.noRight') && none.includes('link.none') && !none.includes('link.loadFailed'));
  const can = render({ can: true, links: [{ id: 'l1', source: 'mail', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-31T00:00:00Z', mine: true }] });
  assert.ok(can.includes('link.make') && can.includes('link.fromMail') && !can.includes('link.noRight') && !can.includes('link.loadFailed'));
});
