import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSide, sideParam, withSide } from '../app/c/[ws]/split.mjs';

test('parseSide — crew/doc spec을 type·key로', () => {
  assert.deepEqual(parseSide('crew:haram-editor'), { type: 'crew', key: 'haram-editor' });
  assert.deepEqual(parseSide('doc:notes/brand-voice.md'), { type: 'doc', key: 'notes/brand-voice.md' });
  // key 안의 ':'는 첫 구분자 뒤로 전부 key
  assert.deepEqual(parseSide('doc:a:b'), { type: 'doc', key: 'a:b' });
});

test('parseSide — 잘못된 spec은 null', () => {
  for (const bad of [null, undefined, '', 'crew', 'crew:', ':x', 'room:abc', 'nope', 42]) {
    assert.equal(parseSide(bad), null, String(bad));
  }
});

test('sideParam ↔ parseSide 왕복 — 한글 slug 포함', () => {
  for (const side of [{ type: 'crew', key: '클로에-편집' }, { type: 'doc', key: 'notes/브랜드 톤.md' }]) {
    const str = sideParam(side);
    assert.deepEqual(parseSide(str), side);
    // URLSearchParams 인코딩을 거쳐도 동일
    const sp = new URLSearchParams(); sp.set('side', str);
    assert.deepEqual(parseSide(new URLSearchParams(sp.toString()).get('side')), side);
  }
  assert.equal(sideParam(null), '');
  assert.equal(sideParam({ type: 'room', key: 'x' }), '');
});

test('withSide — 기존 쿼리·해시 보존, 교체·제거', () => {
  assert.equal(withSide('/c/ws1', 'crew:a'), '/c/ws1?side=crew%3Aa');
  assert.equal(withSide('/c/ws1/vault?doc=notes%2Fx.md', 'crew:a'), '/c/ws1/vault?doc=notes%2Fx.md&side=crew%3Aa');
  assert.equal(withSide('/c/ws1?side=crew%3Aa&q=1', 'doc:n.md'), '/c/ws1?side=doc%3An.md&q=1');
  assert.equal(withSide('/c/ws1?side=crew%3Aa&q=1', ''), '/c/ws1?q=1');
  assert.equal(withSide('/c/ws1?side=crew%3Aa', null), '/c/ws1');
  assert.equal(withSide('/c/ws1#top', 'crew:a'), '/c/ws1?side=crew%3Aa#top');
});

test('withSide 결과를 다시 parseSide — 한글 왕복', () => {
  const href = withSide('/c/ws1/crew/a', sideParam({ type: 'crew', key: '클로에' }));
  const sp = new URLSearchParams(href.slice(href.indexOf('?') + 1));
  assert.deepEqual(parseSide(sp.get('side')), { type: 'crew', key: '클로에' });
});
