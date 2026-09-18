// supabase/migrations의 파일명 버전(앞 숫자)은 겹치면 안 된다. 적용 도구(supabase CLI·적용 스크립트)는 버전만 보고
// 이미 적용된 것으로 판단해 뒤 파일을 조용히 건너뛴다 — 병렬 세션이 같은 버전을 고른 사고(2026-09-16 friend_link,
// 적용 스크립트가 한 파일을 건너뜀)가 git 충돌로 드러나지 않았다(파일명이 달라서). 새 중복은 여기서 red가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// 허용 목록 — 이미 main과 라이브에 들어간 기존 중복만. 이유를 함께 적고, 새 항목은 늘리지 않는다.
const KNOWN_DUPLICATES = {
  // 20260903120000_msgr.sql(메신저 기반 스키마)과 20260903120000_tg_claims_pro_gate_exception.sql이 병렬로 같은 버전을 골랐다.
  // 두 파일 모두 라이브에 적용돼 있음을 대상 객체로 확인했다(2026-09-18). 이름을 바꾸면 이미 적용된 기록과 어긋나므로 그대로 둔다.
  '20260903120000': ['20260903120000_msgr.sql', '20260903120000_tg_claims_pro_gate_exception.sql'],
};

function versionDuplicates(names, known = KNOWN_DUPLICATES) {
  const byVersion = new Map();
  for (const n of names) {
    const m = /^(\d+)_.+\.sql$/.exec(n);
    if (!m) continue;
    byVersion.set(m[1], [...(byVersion.get(m[1]) ?? []), n]);
  }
  const out = [];
  for (const [v, files] of byVersion) {
    if (files.length < 2) continue;
    const allowed = known[v];
    if (allowed && files.length === allowed.length && files.every((f) => allowed.includes(f))) continue; // 허용 목록과 정확히 같을 때만
    out.push({ version: v, files: files.sort() });
  }
  return out;
}

test('마이그레이션 파일명 버전은 겹치지 않는다(기존 허용 목록 제외)', () => {
  const names = readdirSync(new URL('../supabase/migrations/', import.meta.url));
  assert.deepEqual(versionDuplicates(names), [], '같은 버전의 마이그레이션이 있다 — 뒤 파일의 버전을 올린다');
});

test('마이그레이션 파일명은 모두 14자리 버전 + 소문자·숫자·밑줄 이름이다', () => {
  // 숫자 없는 파일(fix_policy.sql)은 supabase CLI가 경고만 내고 적용하지 않으며, 13·15자리 버전은 정렬 순서를 틀어 먼저·나중이 뒤바뀐다 — 둘 다 조용한 누락이다.
  const bad = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((n) => n.endsWith('.sql') && !/^\d{14}_[a-z0-9_]+\.sql$/.test(n));
  assert.deepEqual(bad, [], '버전 14자리(YYYYMMDDHHMMSS)_이름.sql 모양이 아니다');
});

test('판정 자체: 새 중복·허용 쌍에 세 번째 파일이 붙은 경우는 잡고, 허용 쌍만은 통과시킨다', () => {
  const base = ['20260903120000_msgr.sql', '20260903120000_tg_claims_pro_gate_exception.sql', '20260918130000_a.sql'];
  assert.deepEqual(versionDuplicates(base), []);
  assert.deepEqual(versionDuplicates([...base, '20260918130000_b.sql']), [{ version: '20260918130000', files: ['20260918130000_a.sql', '20260918130000_b.sql'] }]);
  assert.equal(versionDuplicates([...base, '20260903120000_third.sql']).length, 1, '허용 버전에 파일이 늘면 다시 잡는다');
  assert.deepEqual(versionDuplicates(['20260101000000_x.sql', 'README.md', '20260101000000_x.sql.bak']), [], 'sql이 아닌 파일은 세지 않는다');
});
