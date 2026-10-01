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
    const Header = new Function('require', 'useSession', 'SPACES', 'ME', 'PEOPLE', 't', 'baseOf', 'Link', 'Icon', 'SaveStatus', 'WidthToggle', 'FavToggle', `${compiled}\nreturn Header;`)(
      require, useSession, [{ key: 'me', kind: 'me', name: 'Office' }], { name: 'User' }, [{ name: 'Crew' }],
      (key) => key, () => '/me', ({ to, children }) => createElement('a', { href: to }, children), () => null, () => null, () => createElement('i', { className: 'width-toggle' }), () => createElement('i', { className: 'fav-toggle' }),
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
    }
    // 이유(유건 9/30): 폭 제한이 없는 화면에서는 눌러도 바뀌는 게 없다 — 설정·휴지통·모듈 보관함·메일에서는 숨긴다
    for (const r of [{ view: 'settings' }, { view: 'trash' }, { view: 'mail' }, { view: 'business', tab: 'library' }]) {
      const html = renderToStaticMarkup(createElement(Header, { r: { space: 'me', ...r } }));
      assert.ok(!html.includes('width-toggle'), `${r.view}/${r.tab ?? ''}`);
    }
    assert.deepEqual(counts, [1, 1, 1]);
  });
}
