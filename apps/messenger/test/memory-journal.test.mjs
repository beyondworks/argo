// 기억 탭 첫 화면의 "최근 일지"(채널·DM) — 유건 제보 2026-09-16 "기억 페이지에 아직도 안 쌓인다":
// 채널 일지는 9/14부터 서버 트리거로 쌓였지만 (1) 폰 첫 화면(조직 전체 기억)은 전사 문서만 보여 비어 보였고 (2) DM은 일지 대상이 아니었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const gw = readFileSync(new URL('../../../src/gateway/msgr.mjs', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../../../supabase/migrations/20260916020000_msgr_dm_journal.sql', import.meta.url), 'utf8');

test('조직 전체 기억 화면에 최근 일지(채널·DM) 목록 — 전사 문서가 0이어도 비지 않는다', () => {
  assert.match(app, /const journals = useMemo\(\(\) => docs\.filter\(\(d\) => d\.channel_id && d\.path\.startsWith\('journal\/'\)\)/, '최근 일지 = 채널 범위 journal/ 문서(DM 포함) — 술어 한 벌(검수 M-3)');
  assert.match(app, /\{sel === 'org' && journals\.length > 0 && \(/, '목록은 journals로');
  assert.match(app, /\.not\('path', 'like', 'journal\/%'\)\.order\('path'\)\.limit\(400\)/, '비일지 400 창은 일지를 제외(검수 HIGH-2)');
  assert.match(app, /\.like\('path', 'journal\/%'\)\.order\('updated_at', \{ ascending: false \}\)\.limit\(30\)/, '일지는 최신순 30건 별도 조회');
  assert.match(app, /const docRelOf = \(d\) => `docs\/\$\{d\.channel_id \?\? 'org'\}\/\$\{d\.path\.replace/, '문서 탭 id에 채널 포함(검수 HIGH-1: 같은 날짜 일지 충돌)');
  assert.equal((app.match(/`docs\/\$\{d\.path\.replace/g) || []).length, 0, '경로만으로 rel을 만드는 곳이 남아 있지 않다');
  assert.match(app, /t\('mem\.journal\.recent'\)/, '라벨은 사전 키');
  assert.match(app, /!\(sel === 'org' && journals\.length > 0\) && <p className="empty">/, '일지가 있으면 "아직 기억이 없습니다"를 띄우지 않는다(같은 술어)');
  assert.match(i18n, /'mem\.journal\.recent': \['[^']+', '[^']+'\]/, 'ko/en 둘 다');
});

test('DM 일지는 상대 이름으로 표기(dmName 전달)', () => {
  assert.match(app, /<Activity [^\n]*dmName=\{dmName\}/, 'App → Activity에 dmName');
  assert.match(app, /const chLabel = \(id\) => \{ const c = channels\.find\(\(x\) => x\.id === id\); return !c \? t\('act\.deletedChannel'\) : c\.kind === 'dm' \? \(dmName\?\.\(c\) \|\| t\('ui\.dm'\)\) : `#\$\{c\.name\}`; \};/, 'Activity.chLabel: 채널은 #이름, DM은 상대 이름');
  assert.match(app, /<MemDoc doc=\{doc\} isAdmin=\{isAdmin\} nameOfUser=\{nameOfUser\} chName=\{chLabel\}/, 'MemDoc 헤더도 chLabel(# 중복 없음 — 검수 LOW-2)');
});

test('DM 일지가 PC 볼트로 내려가 다른 크루 프롬프트에 새지 않는다 — 미러가 journal/을 받지 않고, 서버 트리거는 DM을 포함한다', () => {
  assert.match(gw, /const index = \(await db\.docsIndex\(orgId\)\)\.filter\(\(d\) => !String\(d\.path \?\? ''\)\.startsWith\('journal\/'\)\);/, 'syncOrgDocs가 journal/ 제외');
  assert.match(mig, /if ch\.id is null or ch\.crew_memory=false or ch\.archived_at is not null then return new; end if;/, "트리거에서 ch.kind='dm' 제외 조건이 사라졌다");
  assert.doesNotMatch(mig, /ch\.kind='dm'/, 'DM 제외 없음');
});
