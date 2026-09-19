// 첫 진입 이름 카드(D5) — 가입 때 이름을 묻지 않아 조직 표시 이름이 이메일 앞부분이 된다.
// 실측(ego, 픽스처 ?noname=1·=empty): 이름 '나'면 카드 없음, 앞부분·빈 이름이면 카드 → 저장 시 msgr_org_members 갱신·사이드바 반영·카드 사라짐, 건너뛰기면 이름 그대로 카드만 닫힘
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../src/i18n.js';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('설정 이름 칸과 같은 저장 경로(msgr_org_members, RLS 본인 갱신)', () => {
  assert.match(src, /const saveMyOrgName = async \(org, me, name, t\) => \{\n  const res = await supabase\.from\('msgr_org_members'\)\.update\(\{ display_name: name\.trim\(\) \|\| null \}\)/);
  assert.match(src, /if \(res\.error\) return friendlyErr\(res\.error\.message, t\);\n  if \(!res\.data\?\.length\) return t\('set\.name\.noEdit'\);/, '0행이면 바뀌지 않음(#656 검수 조건) — 두 호출부가 같은 판정');
  assert.equal(src.match(/const err = await saveMyOrgName\(org, me, name, t\)/g)?.length, 2, 'DisplayNameRow·NamePrompt');
});
test('비었거나 이메일 앞부분과 같을 때만, 조직별로 한 번(저장·건너뛰기 모두 기억)', () => {
  assert.match(src, /const need = !!me && \(!me\.display_name \|\| me\.display_name === local\);/);
  assert.match(src, /const key = `argo-msgr-name-asked:\$\{org\.id\}`;/);
  assert.match(src, /namePrompt=\{org && !isPersonal && me && !orgLocked \? <NamePrompt/, '개인 공간·잠긴 조직 제외');
  assert.equal(t('name.prompt.desc', 'en', { local: 'kim' }), 'You appear as your email prefix (kim). This is the name people in this organization see.');
  assert.equal(t('name.prompt.desc.empty', 'ko'), '아직 이름이 없어 다른 사람에게 구분되지 않아요. 이 조직에서 보일 이름을 정해 주세요.');
  assert.equal(t('name.prompt.desc.empty', 'en'), 'You don’t have a name yet, so other people can’t identify you. Choose the name shown in this organization.');
});
