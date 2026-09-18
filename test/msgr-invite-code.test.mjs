// 초대 코드 공유·파싱(순수) — 데스크톱 앱(tauri://) 오리진에서는 링크가 열리지 않으므로 코드가 담긴 안내문을 공유하고, 받는 쪽은 무엇을 붙여 넣어도 코드가 뽑혀야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInviteCode, inviteShareText, inviteLink } from '../apps/messenger/src/invite.mjs';

const CODE = 'a'.repeat(40) + '0123abcd';
test('parseInviteCode — 링크·안내문·맨 코드·대문자에서 코드를 뽑고, 없으면 null', () => {
  assert.equal(parseInviteCode(`http://localhost:5183/?invite=${CODE}`), CODE);
  assert.equal(parseInviteCode(`Argo Messenger 초대 코드: ${CODE}\n앱에서 …`), CODE);
  assert.equal(parseInviteCode(`  ${CODE}  `), CODE);
  assert.equal(parseInviteCode(`?invite=${CODE.toUpperCase()}`), CODE.toUpperCase());
  assert.equal(parseInviteCode('invite=zzz'), null); assert.equal(parseInviteCode(''), null); assert.equal(parseInviteCode(undefined), null);
  assert.equal(parseInviteCode('abc'.repeat(15)), null, '48자 미만은 코드가 아니다');
});
test('inviteShareText — 3줄 평문: 누가 어디로 / 링크(브라우저) 또는 코드 한 줄 / 화면과 같은 메뉴 이름 · 며칠 안에(유건 2026-09-18)', async () => {
  const { t: tm } = await import('../apps/messenger/src/i18n.js');
  for (const lang of ['ko', 'en']) {
    const t = (k, v) => tm(k, lang, v);
    const app = inviteShareText(CODE, { origin: 'tauri://localhost', t, inviter: '김효율', org: 'Lean-AX', channels: ['Lean Crew'], days: 7 });
    const lines = app.split('\n');
    assert.equal(lines.length, 3, `${lang}: 3줄`);
    assert.equal(lines[1], CODE, `${lang}: 앱(tauri://)은 코드만 한 줄`);
    assert.ok(lines[0].includes('김효율') && lines[0].includes('Lean-AX') && lines[0].includes('#Lean Crew'), lines[0]);
    assert.ok(lines[2].includes(`'${t('org.join.code')}'`), `${lang}: 메뉴 이름이 화면 문구(org.join.code)와 같다 — ${lines[2]}`);
    assert.ok(/7/.test(lines[2]), `${lang}: 며칠 안에`);
    assert.doesNotMatch(app, /\*\*|\(|친구|friend/i, `${lang}: 마크다운·곁가지 안내 없음`);
    assert.equal(parseInviteCode(app), CODE, `${lang}: 받은 문구를 그대로 붙여 넣어도 코드가 뽑힌다`);
    const web = inviteShareText(CODE, { origin: 'http://localhost:5183', pathname: '/', t, inviter: 'A', org: 'O', channels: ['a', 'b', 'c'], days: null });
    assert.equal(web.split('\n')[1], `http://localhost:5183/?invite=${CODE}`, `${lang}: 브라우저는 링크 한 줄`);
    assert.ok(web.split('\n')[0].includes('2'), `${lang}: 외 N개 채널`);
    assert.ok(!/7|days|일 안에/.test(web.split('\n')[2]), `${lang}: 만료 없음이면 기한을 붙이지 않는다`);
    assert.ok(inviteShareText(CODE, { t, inviter: 'A', org: 'O' }).split('\n')[0].includes('O'), `${lang}: 채널 없는 조직 초대`);
  }
  assert.equal(inviteLink(CODE, { origin: 'tauri://localhost' }), null, '초대 창 링크 칸은 앱에서 코드만');
  assert.equal(inviteLink(CODE, { origin: 'https://m.example', pathname: '/app' }), `https://m.example/app?invite=${CODE}`);
});
test('배선 — App.jsx의 초대가 링크가 아니라 안내문을 복사하고, 조직 메뉴에 "초대 링크·코드로 참여"가 있다', async () => {
  const app = await readFile(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');
  assert.equal((app.match(/inviteShareText\(/g) ?? []).length, 3, '초대 창·관리자 초대·목록 복사 3곳(0.1.30 초대 창으로 통일)');
  assert.doesNotMatch(app, /\$\{location\.origin\}\$\{location\.pathname\}\?invite=/, '앱 오리진 링크 회귀');
  assert.match(app, /acceptInvite\(supabase, code\)/, '수락은 invite-flow(v2 → v1 폴백) 한 곳으로');
  assert.match(app, /parseInviteCode\(joinCode\)/, '가입 버튼은 코드가 뽑힐 때만');
  const i18n = await readFile(new URL('../apps/messenger/src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['inv.share.head', 'inv.share.headMore', 'inv.share.headOrg', 'inv.share.how', 'inv.share.days', 'org.join.code', 'org.join.code.ph', 'org.join.code.go', 'org.join.code.bad']) {
    const line = i18n.split('\n').find((l) => l.startsWith(`  '${k}': [`));
    assert.ok(line && /['"], ['"]/.test(line) && line.trim().endsWith('],'), `i18n ko/en ${k}`);
  }
});
