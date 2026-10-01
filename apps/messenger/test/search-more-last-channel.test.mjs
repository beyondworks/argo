// S22: 메시지 검색이 상한(60)에서 잘리면 'N건 이상' / S27: 조직별 마지막 채널을 이 기기에 기억해 새로고침 뒤 연다.
// 실측(ego, 픽스처): 글 70개 검색 → main '60건' / 수정 '60건 이상'. '디자인 비공개'를 보다 새로고침 → main 'Fixture General' / 수정 '디자인 비공개'
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../src/i18n.js';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('검색 결과가 상한에서 잘렸으면 이상으로 적는다', () => {
  assert.match(src, /\.limit\(SEARCH_LIMIT \+ 1\)/);
  assert.match(src, /const \{ msgs, more, failed \} = await fetchSearchRows\(/); // 자르기·'더 있음' 판정은 search-rows.mjs(행동은 ef-offline.test.mjs가 잠근다)
  assert.match(src, /setSearchRes\(\{ q: qs, msgs, more, failed,/);
  assert.match(src, /t\(res\.more \? 'search\.countMore' : 'search\.count', \{ n: total \}\)/);
  assert.equal(t('search.countMore', 'ko', { n: 60 }), '60건 이상');
  assert.equal(t('search.countMore', 'en', { n: 60 }), '60+ results');
});
test('마지막 채널 — 지금 조직의 채널일 때만 적고, 불러올 때 남아 있으면 연다', () => {
  assert.match(src, /loadedOrg\.current === orgId.*writeLastCh\(orgId, chId\); \}, \[orgId, chId, channels, previewChannels\]\);/);
  assert.match(src, /const last = readLastCh\(id\); return has\(last\) \? last : \(chs\[0\]\?\.id \?\? null\);/, '조직');
  assert.match(src, /const last = readLastCh\(PERSONAL\); return has\(last\) \? last : \(chs\[0\]\?\.id \?\? null\);/, '개인 공간');
});

test('마지막 공간(조직·개인)도 기억해 앱을 다시 켜면 거기서 연다 — 지금 공간이 없을 때만, 목록에 남아 있을 때만', () => {
  assert.match(src, /useEffect\(\(\) => \{ if \(orgId\) writeLastOrg\(orgId\); \}, \[orgId\]\);/);
  assert.match(src, /setOrgId\(\(cur\) => pickStartSpace\(\{ personal: PERSONAL, cur, orgIds, last: readLastOrg\(\), personalHasContent \}\)\);/, '규칙 자체(지금 공간 → 마지막 공간 → 첫 조직)는 pickStartSpace — test/start-space.test.mjs가 행동으로 잠근다');
});
