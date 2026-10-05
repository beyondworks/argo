// UX 판독(2026-10-05) 표시 항목 — App.jsx의 실제 식을 꺼내 돌린다. APP_SRC를 주면 그 파일로(수정 전 비교용).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { koJosa } from '../src/ko-josa.mjs';
import { t as tm } from '../src/i18n.js';

const app = readFileSync(process.env.APP_SRC || new URL('../src/App.jsx', import.meta.url), 'utf8');

test('UXM-15 꺼진 에이전트 안내는 조사를 고른다 — "Fixture Agent은(는)"이 아니라 "Fixture Agent는"(한국어), 영어는 그대로', () => {
  const line = app.split('\n').find((l) => l.includes('className="msgr-replychip msgr-awaychip"'));
  const expr = line.slice(line.indexOf('<span className="q">{') + '<span className="q">{'.length, line.indexOf('}</span><button type="button" className="msgr-titlebtn" onClick={() => setAwayNote(null)}'));
  const run = (lang) => new Function('awayNote', 'lang', 'koJosa', 't', `return (${expr});`)([{ display_name: 'Fixture Agent' }, { display_name: '페퍼' }], lang, koJosa, (k, v) => tm(k, lang, v));
  assert.equal(run('ko'), 'Fixture Agent는 지금 꺼져 있어요 — 다시 켜지면 이 글에 답합니다. 페퍼는 지금 꺼져 있어요 — 다시 켜지면 이 글에 답합니다.');
  assert.match(run('en'), /^Fixture Agent is offline/);
});
