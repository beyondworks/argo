// 앱 내 검색(⌘K) + 레일 '멤버' 절(역할별) + 프로필 메뉴 배경 — 유건 지시 2026-09-09. JSX 소스 핀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const css = read('apps/messenger/src/styles.css');
test('검색: 레일 검색 칸·⌘K·ilike 이스케이프·결과 페이지(메시지·사람·에이전트·채널)', () => {
  for (const k of ['search.title', 'search.ph', 'search.hint', 'search.none', 'search.count', 'search.channels', 'search.people', 'search.agents', 'search.messages']) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  assert.match(app, /<form className="msgr-search" onSubmit=/, '검색 칸'); assert.match(app, /e\.key\.toLowerCase\(\) === 'k'\) \{ e\.preventDefault\(\); setRail\(true\); searchRef\.current\?\.focus\(\);/, '⌘K');
  assert.match(app, /const scoped = isPersonal \? base\.is\('org_id', null\) : base\.eq\('org_id', org\.id\);/, '검색 범위 — 조직에서는 그 조직, 개인 공간에서는 조직 없는 내 방(가상 org id로 조회하면 늘 빈다)');
  assert.match(app, /scoped\.is\('deleted_at', null\)\.ilike\('body', like\)/, '본문 부분 일치·삭제 글 제외(RLS가 읽을 수 있는 채널만)');
  assert.match(app, /const like = `%\$\{qs\.replace\(\/\[%_\\\\\]\/g/, 'ilike 와일드카드 이스케이프');
  assert.match(app, /\) : page === 'search' && org \? \(\n\s*<SearchPage res=\{searchRes\}/, '페이지 분기'); assert.match(app, /function SearchPage\(\{ res, channels, crews/, '결과 페이지');
});
test('레일은 이동만(검색·채널·1:1·내 에이전트): 멤버·친구 절 없음, 행은 아바타·이름·상태점, 소속별은 소제목; 친구는 설정 탭; 프로필 메뉴는 배경 명시', () => {
  assert.doesNotMatch(app, /t\('rail\.members'\)|msgr-railhint/, '레일에 멤버 절·안내문 없음(유건 지적: 복잡)');
  // 친구 절은 개인 공간에만(유건 2026-09-17 카톡식: 개인 홈=친구, 채팅 탭=채팅) — 조직 레일에는 여전히 없다
  assert.equal((app.match(/t\('rail\.friends'\)/g) || []).length, 1, '친구 절은 한 곳');
  assert.match(app, /\{isPersonal && !dmTab && \(<RailSection id="friends" label=\{`\$\{t\('rail\.friends'\)\}/, '친구 절은 개인 공간 홈에서만');
  assert.match(app, /const railArgo = myCrews\.filter\(\(c\) => sourceOf\(c\) === 'argo'\); const railExt = myCrews\.filter\(\(c\) => sourceOf\(c\) !== 'argo'\);/, '평평한 목록 + 외부만 소제목(유건 결정)'); assert.doesNotMatch(app, /folderHead\(|msgr-folderpick|rail\.folder\.none/, '그룹 UI 없음'); assert.doesNotMatch(app.slice(app.indexOf('const railRow'), app.indexOf('const railArgo')), /msgr-klabel src/, '행에 출처 글자 없음');
  assert.match(app, /\['friends', 'set\.tab\.friends'\]/, '설정 친구 탭'); assert.match(app, /\{tab === 'friends' && <FriendsCard/, '친구 카드는 친구 탭');
  assert.match(i18n, /'set\.tab\.friends': \['[^']+', '[^']+'\]/);
  assert.match(css, /\.msgr-rowmenu\.me \{[^}]*background: var\(--card\); border: 1px solid var\(--border\);/, '프로필 메뉴 배경(실측: 배경 없이 글자만)');
});
