// 폰 설정(유건 피드백 5·9, 2026-10-01 밤): 톱니는 어느 탭에서 눌러도 같은 '설정' 한 화면 — 묶음 순서 개인 / 조직 / 에이전트 / 서버 / 기억 / 공통.
// 에이전트·기억 탭에서 열면 그 묶음으로 바로 스크롤. 조직 범위 화면은 그 조직 공간으로 바꿔 그린다. 배선은 App.jsx라 소스로 잠근다(행동은 보고서의 ego 측정).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const list = src.slice(src.indexOf("if (!sub) return body(t('ui.settings')"), src.indexOf("return body(t(`phone.set.${sub}`)"));

test('설정 묶음 순서 — 개인 · 조직(조직마다 한 줄) · 에이전트 · 서버(관리자 조직이 있을 때) · 기억 · 공통', () => {
  const order = [...list.matchAll(/group\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['me', 'orgs', 'agents', 'server', 'memory', 'common']);
  assert.match(list, /orgs\.map\(\(o\) => row\(o\.id, <Av name=\{o\.name\} size="sm" \/>, o\.name, \(\) => onOrgSub\?\.\('org', o\.id\)/, '조직마다 조직 프로필·계정 한 줄');
  assert.match(list, /adminOrgs\.length > 0 && group\('server'/, '서버 묶음은 조직 관리자에게만');
  assert.equal((list.match(/onSub\?\.\('profile'\)/g) ?? []).length, 1, "맨 위 '나' 카드와 '내 프로필·계정' 줄은 하나");
});

test('톱니는 탭마다 같은 화면 — 에이전트·기억 탭은 그 묶음으로 바로 스크롤', () => {
  assert.match(src, /const gearAct = \{ key: 'gear', icon: 'gear', label: t\('ui\.settings'\), run: \(\) => openSettings\(\) \};/);
  assert.match(src, /actions=\{\[searchAct, \{ \.\.\.gearAct, run: \(\) => openSettings\(null, 'agents'\) \}\]\}/);
  assert.match(src, /\{ \.\.\.gearAct, run: \(\) => openSettings\(null, 'memory'\) \}/);
  assert.match(src, /document\.querySelector\(`\.ph-setlist \[data-group="\$\{focusGroup\}"\]`\)\?\.scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(src, /const openOrgSub = \(kind, id\) => \{ if \(orgId !== id\) setOrgId\(id\); setPage\(`set-\$\{kind\}:\$\{id\}`\); \};/, '조직 범위 화면은 그 조직 공간으로');
  assert.match(src, /const scoped = !!scopeId; const ready = !scoped \|\| \(org\?\.id === scopeId && spaceReady && !gated\);/, '공간이 바뀌어 목록이 올 때까지는 기다림 표시');
});

test('조직 프로필 — 역할 표시와 본인 부서·직급(남의 것은 글자로만), 관리자에게만 조직 설정 진입', () => {
  const card = src.slice(src.indexOf('function OrgProfileCard('), src.indexOf('function MemoryChannelsCard('));
  assert.match(card, /t\(`role\.\$\{org\.role\}`\)/);
  assert.match(card, /<MemberProfile org=\{org\} m=\{\{ user_id: uid \}\} uid=\{uid\}/);
  assert.match(src, /\{isAdmin && <div className="ph-setgroup">\{row\('admin', ic\('gear'\), t\('phone\.org\.settings'\)/);
  const mem = src.slice(src.indexOf('function MemoryChannelsCard('), src.indexOf("/* ─── 폰 조직 설정 '기록'"));
  assert.match(mem, /const can = !locked && \(isAdmin \|\| c\.created_by === uid \|\| \(c\.admin_user_ids \?\? \[\]\)\.includes\(uid\)\);/, '채널 관리자만, 정책 고정이면 잠금');
});
