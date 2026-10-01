// 초대 코드 입력(UX 점검 C) — 코드가 아닌 값을 넣으면 확인 버튼이 회색이 되고 이유가 안 보였다.
// 버튼은 입력이 있으면 켜 두고, 눌렀을 때 입력 아래에 이유를 보인다(checkJoinInput이 이유 문구 키를 돌려준다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkJoinInput, canSubmitJoin } from '../src/invite.mjs';
import { t } from '../src/i18n.js';

const CODE = 'a'.repeat(48);

test('코드가 아닌 값 — 버튼은 눌려야 하고(입력이 있으니), 누르면 이유 문구 키가 나온다', () => {
  assert.equal(canSubmitJoin('abc123'), true);
  assert.deepEqual(checkJoinInput('abc123'), { hint: 'org.join.code.bad' });
  assert.match(t('org.join.code.bad', 'ko'), /초대 코드를 찾지 못했습니다/);
  assert.match(t('org.join.code.bad', 'en'), /No invite code found/);
});

test('빈 입력은 버튼을 막는다(이유를 보일 대상이 없다)', () => {
  assert.equal(canSubmitJoin(''), false);
  assert.equal(canSubmitJoin('   \n'), false);
  assert.equal(canSubmitJoin(null), false);
});

test('맨 코드·링크·안내문은 그대로 코드를 돌려준다(기존 동작 유지)', () => {
  assert.deepEqual(checkJoinInput(CODE), { code: CODE });
  assert.deepEqual(checkJoinInput(`https://x.example/?invite=${CODE}`), { code: CODE });
  assert.deepEqual(checkJoinInput(`린 컴퍼니에 초대했어요\n붙여 넣으세요: ${CODE}\n7일 안에`), { code: CODE });
});

test('앱: 폼이 이유를 입력 아래에 보이고, 입력을 고치면 지운다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /disabled=\{!canSubmitJoin\(joinCode\)\}/, '버튼은 비었을 때만 막힌다');
  assert.match(app, /joinHint && <p className="msgr-inline-err" role="alert">\{t\(joinHint\)\}<\/p>/, '입력 아래 이유');
  assert.match(app, /onChange=\{\(e\) => \{ setJoinCode\(e\.target\.value\); setJoinHint\(null\); \}\}/, '입력을 고치면 이유를 지운다');
});

// 검수 #797 MEDIUM-2 — 잘린 초대 링크(?invite=abc)를 열면 이유가 인라인 폼(joinCode !== null일 때만 그려진다)에만 있어 아무 안내가 없었다.
test('앱: joinByCode는 이유 키를 돌려주고, 링크로 들어온 길은 그 이유를 전역 알림(setErr)으로 보인다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const chk = checkJoinInput\(raw\); if \(chk\.hint\) \{ setJoinHint\(chk\.hint\); return chk\.hint; \}/);
  assert.match(app, /if \(code\) \{ history\.replaceState\(history\.state, '', location\.pathname\); const hint = await joinByCode\(code\); if \(hint\) setErr\(t\(hint\)\); \}/);
});
