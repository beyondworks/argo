// 반응 이모티콘 목록(emoji.js) — 유건 2026-10-08 "이모티콘 더 많이 넣어줘"로 69개 → 310개.
// 잠그는 것: 중복 0(격자 key가 이모티콘), 완전한 형태(RGI), 검색어 한/영, 묶음 제목 ko/en, 검색으로 새 이모티콘 찾기,
// 오래된 기기에서 네모로 보이지 않을 것(Unicode 12.1 이하 코드 포인트·ZWJ 없음), DB 제약(length 1~16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_GROUPS, ALL_EMOJI, searchEmoji, topEmoji } from '../src/emoji.js';
import { DICT } from '../src/i18n.js';

// Unicode 13.0 이상에서 생긴 이모지 코드 포인트(126개). 만든 방법(2026-10-08):
// node 22(Unicode 17)의 \p{Emoji} 전체 → macOS /usr/bin/perl 5.34(UCD 13.0.0) charprop(cp,'Age')가 V13_0 또는 Unassigned인 것.
// 이유: Windows 10 일반 배포판은 Emoji 12.0까지만 그린다(12.1·13.0은 Windows 11부터, emojipedia Windows 11 'new' 페이지).
const NEWER_THAN_12_1 = [[0x1F6D6, 0x1F6D8], [0x1F6DC, 0x1F6DF], [0x1F6FB, 0x1F6FC], [0x1F7F0, 0x1F7F0], [0x1F90C, 0x1F90C], [0x1F972, 0x1F972], [0x1F977, 0x1F979], [0x1F9A3, 0x1F9A4],
  [0x1F9AB, 0x1F9AD], [0x1F9CB, 0x1F9CC], [0x1FA74, 0x1FA77], [0x1FA7B, 0x1FA7C], [0x1FA83, 0x1FA8A], [0x1FA8E, 0x1FA8F], [0x1FA96, 0x1FAC6], [0x1FAC8, 0x1FAC8], [0x1FACD, 0x1FADC], [0x1FADF, 0x1FAEA], [0x1FAEF, 0x1FAF8]];
// 9/9부터 있던 🫡(Emoji 14.0) 하나만 예외 — 빼면 쓰던 사람의 선택지가 사라진다. 새로 넣는 것은 예외 없음.
const LEGACY_NEWER = new Set(['🫡']);
const newer = (e) => [...e].map((c) => c.codePointAt(0)).some((cp) => NEWER_THAN_12_1.some(([a, b]) => cp >= a && cp <= b));

test('묶음 — 업무가 맨 앞, 키는 서로 다르고 300개 안팎', () => {
  assert.equal(EMOJI_GROUPS[0].key, 'work');
  const keys = EMOJI_GROUPS.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, `묶음 키 중복: ${keys}`);
  for (const k of ['work', 'face', 'hand', 'heart', 'animal', 'food', 'activity', 'thing']) assert.ok(keys.includes(k), `묶음 ${k}`);
  assert.ok(ALL_EMOJI.length >= 280 && ALL_EMOJI.length <= 340, `전체 ${ALL_EMOJI.length}개`);
  for (const g of EMOJI_GROUPS) assert.ok(g.items.length >= 10, `${g.key} ${g.items.length}개`);
});

test('같은 이모티콘이 두 번 나오지 않는다(격자 key = 이모티콘)', () => {
  const seen = new Map();
  for (const g of EMOJI_GROUPS) for (const [e] of g.items) seen.set(e, [...(seen.get(e) ?? []), g.key]);
  const dups = [...seen].filter(([, gs]) => gs.length > 1);
  assert.deepEqual(dups, []);
});

test('항목마다 완전한 형태의 이모지(RGI)이고 검색어에 한글·영어가 모두 있다', () => {
  for (const [e, k] of ALL_EMOJI) {
    assert.match(e, /^\p{RGI_Emoji}$/v, `${e} 완전한 형태(FE0F 포함)`);
    assert.match(k, /[가-힣]/, `${e} 한글 검색어: ${k}`);
    assert.match(k, /[a-z]/i, `${e} 영어 검색어: ${k}`);
    assert.ok([...e].length >= 1 && [...e].length <= 16, `${e} msgr_reactions.emoji check(length 1~16)`);
  }
});

test('묶음 제목은 사전에 ko·en 둘 다 있다', () => {
  for (const { key } of EMOJI_GROUPS) {
    const v = DICT[`emoji.${key}`];
    assert.ok(Array.isArray(v) && v.length === 2, `emoji.${key} 없음`);
    assert.match(v[0], /[가-힣]/, `emoji.${key} ko`);
    assert.ok(v[1] && !/[가-힣]/.test(v[1]), `emoji.${key} en`);
  }
});

test('검색 — 새로 넣은 이모티콘을 한글·영어로 찾고, 원래 찾던 것도 그대로 찾는다', () => {
  const has = (q, ...want) => { const hits = searchEmoji(q) ?? []; for (const w of want) assert.ok(hits.includes(w), `'${q}' → ${w} (결과 ${hits.join('')})`); };
  has('고양이', '🐱'); has('cat', '🐱');
  has('피자', '🍕'); has('pizza', '🍕');
  has('하트', '❤️', '🧡', '💙'); has('heart', '❤️', '🖤', '🤍');
  has('휴가', '🏖️'); has('vacation', '🏖️');
  has('커피', '☕'); has('라면', '🍜'); has('축구', '⚽'); has('해골', '💀'); has('facepalm', '🤦');
  has('확인', '✅', '👀'); has('ok', '✅', '👌'); has('경례', '🫡'); has('100', '💯');
  assert.equal(searchEmoji('   '), null, '빈 검색 = 분류 보기');
  assert.deepEqual(searchEmoji('없는검색어zzqx'), []);
});

test('Unicode 12.1 이하만 — ZWJ·피부색·국기 없음, 13.0+ 코드 포인트는 🫡 하나뿐', () => {
  for (const [e] of ALL_EMOJI) {
    assert.doesNotMatch(e, /[‍\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/u, `${e} 조합·피부색·국기(Emoji 12.1+ 조합이 섞인다)`);
    assert.ok(!newer(e) || LEGACY_NEWER.has(e), `${e} Unicode 13.0 이상 — Windows 10에서 네모로 보인다`);
  }
  assert.deepEqual(ALL_EMOJI.map(([e]) => e).filter(newer), [...LEGACY_NEWER], '예외 목록과 실제 13.0+ 항목이 같다');
  // 판정기 자체 확인 — 13.0(🥲·🤌·🧋)·14.0(🫠)·15.0(🫨)은 걸리고 12.0(🥱·🤎)·옛것(😀)은 통과
  for (const e of ['🥲', '🤌', '🧋', '🫠', '🫨']) assert.ok(newer(e), `${e} 걸려야 한다`);
  for (const e of ['🥱', '🤎', '🟢', '😀', '❤️']) assert.ok(!newer(e), `${e} 통과해야 한다`);
});

test('자주 사용 기본값 9개는 그대로이고 모두 목록 안에 있다', () => {
  const freq = topEmoji(9); // node에는 localStorage가 없다 → 빈 빈도 → 기본값
  assert.deepEqual(freq, ['✅', '👀', '👍', '🙏', '👏', '🎉', '❤️', '🔥', '💯']);
  const all = new Set(ALL_EMOJI.map(([e]) => e));
  for (const e of freq) assert.ok(all.has(e), `${e} 목록에 없음`);
});
