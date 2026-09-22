// 첨부 Storage 키 규칙은 서버(크루 답변)와 앱(사람이 올린 첨부) 두 곳에 있다 — 복제본이라 어긋나면
// 같은 파일이 두 규칙으로 올라가 키가 갈린다(분리 검수 L5). 한글 이름은 Storage가 거부했다(라이브 2026-09-23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageKey as serverKey } from '../src/gateway/msgr.mjs';
import { storageKey as appKey } from '../apps/messenger/src/attach-files.mjs';

const NAMES = ['out.pdf', 'Kimi-K3-브리프-전문.md', '보고서.md', '.hidden', 'no-ext', 'a'.repeat(120) + '.TXT', '한글 이름 (사본).png', 'weird…name?.jpeg', ''];

test('서버와 앱의 Storage 키 규칙이 같다(이름·순번 모두)', () => {
  for (const n of NAMES) for (const i of [0, 1, 7]) assert.equal(serverKey(n, i), appKey(n, i), `규칙이 갈렸다: ${JSON.stringify(n)} #${i}`);
});

test('만들어진 키는 ASCII만 남고 순번이 앞에 붙는다 — 한글만 있는 이름도 빈 키가 되지 않는다', () => {
  for (const n of NAMES) {
    const k = serverKey(n, 3);
    assert.match(k, /^3-[A-Za-z0-9._-]+$/, `ASCII 밖 문자 또는 순번 누락: ${k}`);
  }
  assert.notEqual(serverKey('브리프.md', 0), serverKey('전문.md', 1), '한글 이름이 같은 키로 뭉치면 첨부가 덮인다');
});
