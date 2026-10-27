// 계정 삭제가 소유 조직 때문에 거부될 때의 안내(2026-10-27 총괄 결정) — v2는 동작하지 않는 "소유권 이전"을 빼고 멤버 내보내기만, 경로는 실제 메뉴 이름.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerDeleteBlockedCopy } from '../src/owner-delete-copy.mjs';
import { t } from '../src/i18n.js';

const tl = (lang) => (k, v) => t(k, lang, v);

test('v2 데스크톱·폰: 소유권 이전을 말하지 않고, 남은 멤버를 내보내는 실제 경로를 ko·en으로 안내한다', () => {
  assert.equal(ownerDeleteBlockedCopy(tl('ko'), { v2: true, phone: false, orgs: 'Beyond 팀' }), '먼저 남은 멤버를 내보내야 하는 조직이 있습니다: Beyond 팀. 설정 › 멤버에서 남은 멤버를 모두 내보낸 뒤 다시 시도하세요.');
  assert.equal(ownerDeleteBlockedCopy(tl('ko'), { v2: true, phone: true, orgs: 'Beyond 팀' }), '먼저 남은 멤버를 내보내야 하는 조직이 있습니다: Beyond 팀. 나 › 조직 프로필·계정 › 조직 설정 › 멤버에서 남은 멤버를 모두 내보낸 뒤 다시 시도하세요.');
  assert.equal(ownerDeleteBlockedCopy(tl('en'), { v2: true, phone: false, orgs: 'Acme' }), 'Remove the remaining members first in: Acme. Go to Settings › Members, remove every remaining member, then try again.');
  assert.equal(ownerDeleteBlockedCopy(tl('en'), { v2: true, phone: true, orgs: 'Acme' }), 'Remove the remaining members first in: Acme. Go to Me › Organization profile › Organization settings › Members, remove every remaining member, then try again.');
  for (const lang of ['ko', 'en']) for (const phone of [false, true]) assert.doesNotMatch(ownerDeleteBlockedCopy(tl(lang), { v2: true, phone, orgs: 'X' }), /소유권|ownership/i, `${lang}/${phone}`);
});

test('옛(v1) 모드는 종전 문구 그대로(소유권 이전 또는 멤버 내보내기)', () => {
  assert.equal(ownerDeleteBlockedCopy(tl('ko'), { v2: false, phone: true, orgs: 'Org' }), t('acct.delete.transferFirst', 'ko', { orgs: 'Org' }));
  assert.match(ownerDeleteBlockedCopy(tl('en'), { v2: false, orgs: 'Org' }), /Transfer ownership first for: Org/);
});
