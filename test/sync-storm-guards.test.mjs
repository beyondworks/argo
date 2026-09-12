// 동기화 폭풍 가드 — 라이브 실측 2026-09-12(유건 실물 검수 밤) 두 원인의 배선을 잠근다. cycle·discoverRemote는 export가 없어
// 소스 스캔 게이트(레포 선례 test/sync-list-cadence.test.mjs).
//   ① 소유자 접두사가 uuid가 아니면 list를 부르지 않는다 — list('') = 버킷 루트 나열, RLS가 23만 행을 걸러 10~25초(자기 폴더는 17ms).
//   ② 한 사이클의 업로드가 전부 거절(RLS)되면 그 회사는 10분 쉰다 — 플랜 미확인·무자격 기기가 8초마다 같은 파일 100개를 밀어
//      30분에 1만 건 거절을 만들던 폭풍(기기 3대, 누적 storage.objects insert 3,900만 회).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sync.mjs'), 'utf8');

test('발견·tombstone 목록 조회는 소유자 접두사가 있을 때만 — 루트 나열 차단', () => {
  assert.match(SRC, /const ownerPrefixOk = \(o\) => typeof o === 'string' && \/\^\[\^\\s\/\]\+\$\/\.test\(o\) && o !== 'undefined' && o !== 'null';/, 'ownerPrefixOk 정의');
  assert.match(SRC, /for \(const owner of allow\) \{\n\s*if \(!ownerPrefixOk\(owner\)\) \{[^\n]*continue; \}/, 'discoverRemote 루프 첫 줄이 가드');
  assert.match(SRC, /ownerPrefixOk\(owner\) \? await client\(\)\.storage\.from\(BUCKET\)\.list\(skey\(owner, '\.tombstones'\)/, 'tombstone 목록도 같은 가드');
  const ok = new Function('o', "return typeof o === 'string' && /^[^\\s/]+$/.test(o) && o !== 'undefined' && o !== 'null';");
  for (const b of ['', ' ', 'undefined', 'null', 'a/b', undefined, null]) assert.equal(ok(b), false, `루트 나열을 만들던 값 거부: ${JSON.stringify(b)}`);
  for (const g of ['de7fc2f4-7d09-4b8c-9192-406d5b3f2f46', 'owner-a']) assert.equal(ok(g), true, g);
});

test('업로드 전부 거절 → 회사 10분 백오프(cycle 배선)', () => {
  assert.match(SRC, /let uploadDenied = 0;/, 'syncCompany 집계');
  assert.match(SRC, /if \(e\?\.uploadFailed\) uploadDenied\+\+;/, '쓰기 실패 태그만 센다(pull 실패는 절대 아님)');
  assert.match(SRC, /failed, healed, denied, uploadDenied, /, '결과에 실린다');
  assert.match(SRC, /if \(\(uploadBackoff\.get\(wsId\) \?\? 0\) > Date\.now\(\)\) \{ status\.companies\[wsId\] = \{ ts: Date\.now\(\), skipped: 'upload-denied' \}; continue; \}/, '백오프 중이면 회사 스킵');
  assert.match(SRC, /if \(!freePlan && \(r\.uploadDenied \?\? 0\) > 0 && \(r\.pushed \?\? 0\) === 0\) \{/, '전부 거절일 때만(하나라도 밀렸으면 정상)');
  assert.match(SRC, /const UPLOAD_BACKOFF_MS = 10 \* 60_000;/);
});
