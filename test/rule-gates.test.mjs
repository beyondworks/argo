// CLAUDE.md 규칙을 CI에서 막는 시험(2026-10-12). 규칙 문장이 바뀌면 이 시험도 같이 고친다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPr, addedFromDiff, messengerShared, sections } from '../scripts/pr-rules-check.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules' || n.startsWith('.')) return [];
  const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p];
});
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// 삭제류 액션 — window.confirm/prompt는 Tauri 웹뷰에서 동작하지 않는다. DangerModal을 쓴다(오피스 앱은 2026-10-16 이 저장소에서 떼어 냈다).
test('본체·메신저: window.confirm/prompt 금지', () => {
  const code = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'apps/messenger/src'))].filter((p) => /\.(jsx?|mjs)$/.test(p));
  assert.ok(code.length > 50, `검사한 파일이 너무 적다: ${code.length}`);
  for (const p of code) assert.doesNotMatch(strip(readFileSync(p, 'utf8')), /\b(window\.)?(confirm|prompt)\(/, p);
});

const MIG = join(ROOT, 'supabase/migrations');
const migrations = readdirSync(MIG).filter((n) => /^\d+_.+\.sql$/.test(n)).sort();

// DB 위생 7 — 병합 전 마이그레이션 버전 중복 확인
test('마이그레이션 버전 중복 없음', () => {
  const seen = new Map();
  for (const n of migrations) {
    const v = n.split('_')[0];
    assert.ok(!seen.has(v), `버전 ${v} 중복: ${seen.get(v)} · ${n}`);
    seen.set(v, n);
  }
});

// DB 위생 1·전송량 5 — 기억 데이터는 지우지 않고, Storage 객체는 SQL로 지우지 않는다(Storage API로).
// 2026-10-12 이후 새 마이그레이션부터 적용한다(그 전 계정 삭제 함수 msgr_delete_me·msgr_purge_orgs도 대상 — 2026-10-12 유건 승인, Storage API(msgr-storage-sweep)로 바꾸는 수정이 따로 진행 중).
// 유건 승인을 받은 예외는 그 문장 안에 `-- rule-ok: <이유·승인 날짜>` 주석을 단다.
// ponytail: 문장 단위 정규식 — 동적 SQL(execute format)로 이름을 조립하면 못 잡는다. 그런 마이그레이션은 검수에서 본다.
const CUTOFF = '20261012140000';
const FORBIDDEN = /\b(delete\s+from(\s+only)?|truncate(\s+table)?(\s+only)?|drop\s+table(\s+if\s+exists)?)\s+(storage\s*\.\s*objects|(public\s*\.\s*)?msgr_messages|(public\s*\.\s*)?msgr_org_docs)\b/i;
const forbiddenStatements = (sql) => sql
  .replace(/;([ \t]*--[^\n]*rule-ok:[^\n]*)/g, '$1\n;') // 줄 끝 `; -- rule-ok:`는 앞 문장의 예외다
  .split(';').filter((stmt) => {
  if (/--\s*rule-ok:/.test(stmt)) return false;
  const norm = stmt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ').replace(/"/g, '').replace(/\s+/g, ' ');
  return FORBIDDEN.test(norm);
}).map((s) => s.trim().slice(0, 120));
test('새 마이그레이션: storage.objects·기억 데이터 SQL 삭제 금지', () => {
  for (const n of migrations.filter((x) => x.split('_')[0] > CUTOFF)) {
    const bad = forbiddenStatements(readFileSync(join(MIG, n), 'utf8'));
    assert.deepEqual(bad, [], `${n}: ${bad.join(' / ')}`);
  }
});
test('삭제 금지 판정이 변형까지 잡는다(변이 확인)', () => {
  for (const sql of [
    'delete from storage.objects where bucket_id = $1',
    'DELETE FROM public.msgr_messages m',
    'delete from "storage"."objects" where true',
    'delete from public."msgr_messages"',
    'delete from only public.msgr_messages',
    'truncate msgr_messages', 'truncate table storage.objects', 'drop table if exists msgr_org_docs',
    'delete from storage . objects', 'delete\n  from storage.objects\n where true', 'delete /* x */ from storage.objects',
  ]) assert.equal(forbiddenStatements(sql).length, 1, sql);
  assert.deepEqual(forbiddenStatements('delete from msgr_crews where id = $1'), []);
  assert.deepEqual(forbiddenStatements('delete from storage.objects_x'), []);
  assert.deepEqual(forbiddenStatements('delete from storage.objects where true -- rule-ok: 시험'), []);
  assert.equal(forbiddenStatements('delete from storage.objects; -- rule-ok: 시험\ndelete from storage.objects;').length, 1, '줄 끝 예외 주석은 앞 문장에만 걸린다');
});

// PR 본문 규칙 검사 판정(scripts/pr-rules-check.mjs)
const TEMPLATE = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
const shared = messengerShared(ROOT);
test('PR 본문 검사: 메신저 공용 파일 목록을 설정에서 읽는다', () => {
  for (const f of ['app/globals.css', 'app/ui.jsx', 'app/i18n.jsx', 'app/theme.jsx']) assert.ok(shared.has(f), f);
});
test('PR 본문 검사: 문서만 바뀐 PR은 통과', () => {
  assert.deepEqual(checkPr({ body: '', files: ['CLAUDE.md', 'docs/a.md'], shared }), []);
});
test('PR 본문 검사: 템플릿을 채우지 않으면 모두 실패한다', () => {
  const m = checkPr({
    body: TEMPLATE,
    files: ['supabase/migrations/20261013000000_x.sql', 'app/i18n.jsx', 'src/engine/native-query.mjs'],
    added: [{ file: 'src/sync.mjs', line: 'setInterval(tick, 5000)' }],
    shared,
  });
  assert.equal(m.length, 6, m.join('\n'));
});
test('PR 본문 검사: 채운 절은 통과하고 "해당 없음"은 빈 절로 본다', () => {
  const filledBody = TEMPLATE
    .replace('## 영향 반경', '## 영향 반경\n| 맥 | 검증함(npm test) |')
    .replace('## 경우 표', '## 경우 표\n첫 실행: 기대 … 근거 test/x')
    .replace('## 부하', '## 부하\n기기 100대 × 분당 1회 = 분당 100행')
    .replace('## 화면', '## 화면\n메신저 390·1280·880 캡처')
    .replace('## 검수', '## 검수\n분리 검수: MEDIUM 1 고침\n러너: OpenRouter 실턴');
  const files = ['supabase/migrations/20261013000000_x.sql', 'app/i18n.jsx', 'src/engine/native-query.mjs'];
  const added = [{ file: 'src/sync.mjs', line: 'setInterval(tick, 5000)' }];
  assert.deepEqual(checkPr({ body: filledBody, files, added, shared }), []);
  const na = filledBody.replace('첫 실행: 기대 … 근거 test/x', '해당 없음');
  assert.match(checkPr({ body: na, files, added, shared }).join('\n'), /경우 표/);
});
test('PR 본문 검사: 판정 경계(오탐·누락)', () => {
  const body = '## 영향 반경\n맥 검증함\n## 검수\n분리 검수 지적 0';
  assert.deepEqual(checkPr({ body, files: ['src/author.mjs', 'src/async-queue.mjs'], shared }), [], '이름에 sync·auth가 들어 있을 뿐인 파일은 상태 변경으로 보지 않는다');
  for (const f of ['apps/messenger/src/App.jsx', 'app/api/billing/webhook/route.js', 'app/api/auth/pair/route.js', 'src/gateway/msgr-execution.mjs', 'scripts/sql/msgr-automation-scheduler.sql']) {
    assert.match(checkPr({ body, files: [f], shared }).join(''), /경우 표/, f);
  }
  assert.deepEqual(checkPr({ body, files: ['test/msgr-x.test.mjs'], shared }), [], '시험 파일만 바뀌면 경우 표를 요구하지 않는다');
  for (const line of ['const POLL_MS = 3000', 'setTimeout(tick, HEARTBEAT_MS)', 'refetchInterval: 5000', 'setTimeout(poll, 3000)', 'const SYNC_EVERY_MS = 8000', 'const intervalMs = 5000', 'useInterval(fn, 1000)', 'const LEASE_TTL_MS = 120000']) {
    assert.match(checkPr({ body, files: ['src/a.mjs'], added: [{ file: 'src/a.mjs', line }], shared }).join(''), /부하/, line);
  }
  assert.deepEqual(checkPr({ body, files: ['src/a.mjs'], added: [{ file: 'test/a.test.mjs', line: 'setInterval(x, 1)' }], shared }), [], '시험 파일의 주기 호출은 세지 않는다');
  assert.deepEqual(addedFromDiff('+++ b/src/a.mjs\n+x\n-y\n'), [{ file: 'src/a.mjs', line: 'x' }]);
  assert.deepEqual(Object.keys(sections('<!-- 영향 반경 -->\n## 검수\n<!-- 분리 검수 -->')), ['검수']);
  assert.deepEqual(Object.keys(sections('## 영향 반경\n```sh\n# comment\n```')), ['영향 반경'], '코드 블록 안 # 줄은 제목이 아니다');
  assert.deepEqual(checkPr({ body, files: ['src/a.mjs'], added: [{ file: 'src/a.mjs', line: 'setTimeout(close, 0)' }], shared }), [], '짧은 일회성 setTimeout은 주기 호출이 아니다');
});

test('PR 본문 검사: ## 절 안의 ### 소제목은 그 절에 합친다(#961 검수 LOW-1)', () => {
  const files = ['src/sync.mjs'];
  const body = '## 영향 반경\n### 축\n| 맥 | 검증함(npm test) |\n### 산출물\n기능 브랜치뿐\n## 경우 표\n### 첫 실행\n기대 … 근거 test/x\n## 검수\n분리 검수: MEDIUM 1 고침';
  assert.deepEqual(checkPr({ body, files, shared }), [], '소제목 아래 내용이 상위 절의 내용으로 세지지 않았다');
  assert.deepEqual(Object.keys(sections(body)), ['영향 반경', '경우 표', '검수'], '### 소제목이 새 절이 됐다');
  // 소제목 글자만 있고 내용이 없으면 여전히 빈 절이다
  assert.match(checkPr({ body: '## 영향 반경\n### 축\n## 검수\n분리 검수: 지적 0', files, shared }).join('\n'), /영향 반경/);
  // 위에 ## 절이 없으면 ### 도 절로 읽는다(제목 단계를 하나씩 내려 쓴 본문)
  assert.deepEqual(checkPr({ body: '### 영향 반경\n맥 검증함\n### 경우 표\n기대 … 근거\n### 검수\n지적 0', files, shared }), []);
});
test('PR 본문 검사: "대기·pending·TBD"만 있는 절은 빈 절로 본다(#961 검수 LOW-2)', () => {
  const ok = '## 영향 반경\n맥 검증함\n## 검수\n분리 검수: MEDIUM 1 고침';
  assert.deepEqual(checkPr({ body: ok, files: ['src/a.mjs'], shared }), []);
  for (const t of ['분리 검수: 대기', '대기 중', '- 분리 검수: pending', 'TBD', '분리 검수: 대기\n도달 지점: TBD', '검수: 예정']) {
    assert.match(checkPr({ body: ok.replace('분리 검수: MEDIUM 1 고침', t), files: ['src/a.mjs'], shared }).join('\n'), /분리 검수/, JSON.stringify(t));
  }
  // 자리 표시와 실제 내용이 섞이면 채운 것이다(대기 중인 축이 있어도 다른 축의 근거는 내용)
  assert.deepEqual(checkPr({ body: ok.replace('분리 검수: MEDIUM 1 고침', '분리 검수: 대기\n자체 확인: 변이 red 2종'), files: ['src/a.mjs'], shared }), []);
  // "대기"가 낱말 일부인 내용은 자리 표시가 아니다
  assert.deepEqual(checkPr({ body: ok.replace('분리 검수: MEDIUM 1 고침', '분리 검수: 대기열 경합 MEDIUM 고침'), files: ['src/a.mjs'], shared }), []);
});

// 머신 표 — 라이브 DB 적용·iOS 발행은 맥 two(홈 /Users/leankim)에서 거부한다(다른 홈과 시험용 임시 레포는 기존 msgr-live-apply-*.test.mjs가 본다).
test('맥 two에서는 라이브 DB 적용·iOS 발행을 거부한다', { skip: process.platform === 'win32' && 'Windows의 homedir()는 HOME이 아니라 USERPROFILE을 본다 — 맥 전용 규칙' }, () => {
  const env = { ...process.env, HOME: '/Users/leankim' };
  for (const cwd of [ROOT, '/']) { // 다른 폴더에서 불러도 스크립트 위치의 저장소를 본다(재검수 MEDIUM 2)
    const a = spawnSync('bash', [join(ROOT, 'scripts/msgr-live-apply.sh'), 'x'], { cwd, env, encoding: 'utf8' });
    assert.equal(a.status, 5, `${cwd}: ${a.stdout}${a.stderr}`); assert.match(a.stdout, /맥 two/);
  }
  const b = spawnSync(process.execPath, [join(ROOT, 'apps/messenger/scripts/ios-store.mjs'), 'upload'], { env, encoding: 'utf8' });
  assert.equal(b.status, 5, b.stdout + b.stderr); assert.match(b.stderr, /맥 two/);
});
