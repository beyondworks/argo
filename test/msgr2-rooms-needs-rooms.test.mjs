// U6d 시험의 "U6d 적용 전" 판에서 빼는 후속 마이그레이션 목록(helpers/msgr2-rooms-cases.mjs NEEDS_ROOMS)이 실제 파일과 맞는지 — PG 없이 CI에서 본다(#1102 검수 미룸 ①).
// 목록에 없는 새 파일이 U6d 초대 표를 쓰면 PG 시험 준비 단계가 멈추지만, PG 드릴을 안 돌린 PR에서도 알 수 있게 여기서 먼저 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NEEDS_ROOMS, ROOMS_FILE } from './helpers/msgr2-rooms-cases.mjs';

const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const testDir = fileURLToPath(new URL('./', import.meta.url));

test('NEEDS_ROOMS: 목록 파일은 있고 U6d 뒤다, U6d 초대 표를 쓰는 U6d 뒤 msgr2 파일은 모두 목록에 있다, 목록 파일마다 그것을 보는 시험이 있다', () => {
  const files = readdirSync(migDir).filter((x) => /^\d+_msgr2_.*\.sql$/.test(x)).sort();
  for (const f of NEEDS_ROOMS) { assert.ok(files.includes(f), `${f} 없음`); assert.ok(f > ROOMS_FILE, `${f}는 U6d 뒤여야 한다`); }
  const using = files.filter((x) => x > ROOMS_FILE && /msgr2_space_invites/.test(readFileSync(migDir + x, 'utf8')));
  assert.deepEqual(using.filter((x) => !NEEDS_ROOMS.includes(x)), [], '목록에 넣고 setupFull 시험을 두세요');
  const tests = readdirSync(testDir).filter((x) => x.endsWith('.test.mjs')).map((x) => readFileSync(testDir + x, 'utf8'));
  for (const f of NEEDS_ROOMS) assert.ok(tests.some((t) => t.includes(f.replace(/\.sql$/, ''))), `${f}를 보는 시험이 없다`);
});
