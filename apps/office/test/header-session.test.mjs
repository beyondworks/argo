import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import { createElement, useSyncExternalStore } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const header = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body
  .find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'Header');
const compiled = transformSync(source.slice(header.start, header.end), { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code;

for (const mode of ['sample', 'signedIn']) {
  test(`Header home-page-home keeps the same session subscriptions (${mode})`, () => {
    let calls = 0;
    const useSession = () => {
      calls += 1;
      return useSyncExternalStore(() => () => {}, () => mode, () => mode);
    };
    const Header = new Function('require', 'useSession', 'SPACES', 'ME', 'PEOPLE', 't', 'baseOf', 'Link', 'Icon', 'SaveStatus', 'WidthToggle', 'FavToggle', 'HideAllToggle', `${compiled}\nreturn Header;`)(
      require, useSession, [{ key: 'me', kind: 'me', name: 'Office' }], { name: 'User' }, [{ name: 'Crew' }],
      (key) => key, () => '/me', ({ to, children }) => createElement('a', { href: to }, children), () => null, () => null, () => createElement('i', { className: 'width-toggle' }), () => createElement('i', { className: 'fav-toggle' }), () => createElement('i', { className: 'hide-all' }),
    );
    const counts = [];
    for (const view of ['home', 'page', 'home']) {
      calls = 0;
      const html = renderToStaticMarkup(createElement(Header, {
        r: { space: 'me', view }, page: view === 'page' ? { id: 'page-fixture', title: 'Fixture page' } : undefined,
      }));
      counts.push(calls);
      assert.equal(html.includes('page.share'), view === 'page');
      assert.equal(html.includes('draft.badge'), mode === 'sample');
      assert.equal(html.includes('class="presence"'), view === 'page' && mode === 'sample');
      assert.ok(html.includes('width-toggle'), `${view}: 전체 너비 버튼`);
      assert.ok(html.includes('fav-toggle'), `${view}: 즐겨찾기 ☆(유건 10/1 — 저장됨 옆)`);
      assert.ok(html.includes('hide-all'), `${view}: 화면 전체 가리기 단추(18차 — 어느 화면에서나 머리글에)`);
    }
    // 이유(유건 9/30): 폭 제한이 없는 화면에서는 눌러도 바뀌는 게 없다 — 설정·휴지통·모듈 보관함·메일에서는 숨긴다
    for (const r of [{ view: 'settings' }, { view: 'trash' }, { view: 'mail' }, { view: 'business', tab: 'library' }]) {
      const html = renderToStaticMarkup(createElement(Header, { r: { space: 'me', ...r } }));
      assert.ok(!html.includes('width-toggle'), `${r.view}/${r.tab ?? ''}`);
    }
    assert.deepEqual(counts, [1, 1, 1]);
  });
}

// 이유(분리 검수 LOW-11): 공유 링크 토큰이 주소 경로(/f/<토큰>)에 있으면 페이지를 열 때 서버·CDN 접근 기록에 남는다 — 이제 /f#<토큰>(조각)
test('공유 링크 경로: /f(조각에 토큰)만 공개 링크 화면, 옛 /f/<토큰>은 링크 화면이 아니다', () => {
  const fn = (file, name) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const node = parse(src, { sourceType: 'module', plugins: ['jsx'] }).program.body.map((n) => (n.type === 'ExportNamedDeclaration' ? n.declaration : n))
      .find((n) => n?.type === 'FunctionDeclaration' && n.id.name === name);
    return transformSync(src.slice(node.start, node.end), { loader: 'jsx', format: 'cjs' }).code;
  };
  const match = new Function(`${fn('../src/core/router.jsx', 'match')}\nreturn match;`)();
  const route = new Function('match', 'SPACES', 'baseOf', 'VIEWS', `${fn('../src/App.jsx', 'route')}\nreturn route;`)(match, [{ key: 'me', kind: 'me' }], () => '/me', ['home']);
  assert.deepEqual(route('/f'), { space: null, view: 'fileLink' });
  assert.deepEqual(route('/f/'), { space: null, view: 'fileLink' });
  assert.notEqual(route('/f/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd').view, 'fileLink');
});
