// 폰 첫 화면(조직 없음, D22 S109) — 데스크톱 본문의 단계 카드가 폰 홈엔 없고 한 줄 안내뿐이라 새 조직·참여 버튼을 찾을 수 없었다.
// 실측(ego, 픽스처 ?noorg=1 폰 390 ko·en·다크): 수정 전 단계 0·한 줄 안내 → 수정 뒤 [새 조직]·[초대 링크·코드로 참여] 두 단계, 참여 버튼은 입력칸에 초점
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('조직 없는 단계는 한 목록(noOrgSteps) — 데스크톱 본문과 폰 홈이 같이 쓴다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /function noOrgSteps\(\{ t, createOrg, joinWithCode, joinable = \[\], joinDomain, deletedOrgs = \[\], restoreOrg \}\)/);
  assert.match(src, /: noOrgSteps\(\{ t, createOrg, joinWithCode, joinable, joinDomain, deletedOrgs, restoreOrg \}\);/, '데스크톱 빈 화면');
  assert.match(src, /isPhone && !orgId \? <div className="msgr-phsteps"><OrgStepList steps=\{noOrgSteps\(/, '폰 홈');
});
