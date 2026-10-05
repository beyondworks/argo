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

test('UXM-11 데스크톱 친구 링크 끊기가 실패하면 링크를 그대로 둔다 — 실제 FriendsCard call·끊기 단추', async () => {
  const lines = app.split('\n');
  const callLine = lines.find((l) => l.includes('const call = async (fn, args, ok) =>') && l.includes('msgr_friend_blocked') && !l.includes('if (res) await find()')); // FriendsCard 것(FriendFinder 것은 검색 결과를 다시 읽는다)
  const btn = lines.find((l) => l.includes("msgr_friend_link_revoke', {}, t('friends.link.revoked')"));
  const onClick = btn.slice(btn.indexOf('onClick={async () => {') + 'onClick={'.length, btn.indexOf("}}>{t('friends.link.revoke')}") + 1);
  const run = async (ok) => {
    const seen = [];
    const scope = { setBusy: () => {}, q: async () => { if (!ok) throw new Error('network'); return null; }, supabase: { rpc: () => null }, onNote: (m) => seen.push(['note', m]), onChanged: async () => {}, onError: (m) => seen.push(['error', m]), t: (k) => k, setLink: (v) => seen.push(['link', v]) };
    const fn = new Function(...Object.keys(scope), `${callLine}\nreturn (${onClick});`)(...Object.values(scope));
    await fn(); return seen;
  };
  assert.deepEqual(await run(false), [['error', 'network']], '실패 — 링크를 지우지 않는다');
  assert.deepEqual(await run(true), [['note', 'friends.link.revoked'], ['link', null]]);
});

test('UXM-11 폰 친구 추가 시트에도 링크 끊기가 있다', () => {
  const sheet = app.slice(app.indexOf('function PhoneFriendAdd('), app.indexOf('\n}\n', app.indexOf('function PhoneFriendAdd(')));
  assert.match(sheet, /onClick=\{revoke\}>\{t\('friends\.link\.revoke'\)\}/);
  assert.match(sheet, /const revoke = async \(\) => \{ setBusy\(true\); try \{ await q\(supabase\.rpc\('msgr_friend_link_revoke', \{\}\)\); setLink\(null\);/);
});
