// 이름 없는 옛 봇이 백필로 다시 생기지 않게(20261023180000 c절) — 옛 msgr 전체 + msgr2를 운영 순서로 적용한 DB(setupFull)에서 _msgr2_bf_agents를 직접 부른다.
// 경우: 자리(msgr_crews)가 하나도 없는 'bot-'+16진 12자 행 = 옮기지 않음 / 자리 없는 보통 에이전트(검수 #1084) = 종전대로 이름 = slug로 옮김 /
//      모양이 다른 'bot-…'(짧음·대문자) = 옮김 / 다시 불러도 쓰기 0 / 이미 옮겨진 옛 봇 행은 지우지 않음(삭제는 맥 one 별건) / 되돌림 파일을 적용하면 옛 동작(옮김).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-bf-legacy-bots-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFull } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-bf-legacy-bots-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql', import.meta.url));
const O = 'c9000000-0000-4000-8000-000000000001';
const id = (n) => `c9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = { BOT: id(10), BOT2: id(11), PLAIN: id(12), SHORT: id(13), UPPER: id(14), OLDBOT: id(15) };
let db;
const v2 = (x) => db.sql(`select coalesce((select display_name from public.msgr2_agents where id = '${x}'), '-')`);
const run = () => db.sql('select written from public._msgr2_bf_agents(null, 1000)');

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`insert into auth.users (id) values ('${O}') on conflict do nothing`);
  const ag = (x, slug) => db.sql(`insert into public.msgr_agents (id, owner_user_id, ws_id, slug, created_at) values ('${x}', '${O}', 'ws', '${slug}', now())`);
  ag(A.BOT, 'bot-0804ccfb168c'); ag(A.BOT2, 'bot-aaaabbbbcccc'); ag(A.PLAIN, 'research'); ag(A.SHORT, 'bot-short'); ag(A.UPPER, 'bot-0804CCFB168C'); ag(A.OLDBOT, 'bot-0123456789ab');
  // 이미 옮겨진 옛 봇(이 마이그레이션 전 백필이 만든 행) — 지우지 않는다
  db.sql(`insert into public.msgr2_agents (id, owner_user_id, ws_id, slug, display_name, hosting, status) values ('${A.OLDBOT}', '${O}', 'ws', 'bot-0123456789ab', 'bot-0123456789ab', 'local', 'active')`);
});

test('자리 없는 bot-+12자 행은 옮기지 않고, 자리 없는 보통 에이전트·모양이 다른 bot-은 종전대로 옮긴다', { skip }, () => {
  run();
  assert.equal(v2(A.BOT), '-', 'bot-0804ccfb168c 안 옮김');
  assert.equal(v2(A.BOT2), '-', 'bot-aaaabbbbcccc 안 옮김');
  assert.equal(v2(A.PLAIN), 'research', '자리 없는 보통 에이전트는 이름 = slug(검수 #1084 그대로)');
  assert.equal(v2(A.SHORT), 'bot-short', '모양이 다르면 옮긴다');
  assert.equal(v2(A.UPPER), 'bot-0804CCFB168C', '대문자 모양도 옮긴다(앱 판정과 같은 소문자 16진만 건너뜀)');
  assert.equal(v2(A.OLDBOT), 'bot-0123456789ab', '이미 옮겨진 옛 봇 행은 지우지 않는다');
});

test('다시 불러도 쓰기 0(xmin 그대로) — msgr2_backfill_run·restart로 다시 돌아도 같은 행을 되살리지 않는다', { skip }, () => {
  const x0 = db.xmins('msgr2_agents');
  run();
  assert.equal(db.xmins('msgr2_agents'), x0);
  assert.equal(v2(A.BOT), '-');
});

test('되돌림 파일을 적용하면 옛 동작(옮김) — 다시 적용하면 원래대로', { skip }, () => {
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  run();
  assert.equal(v2(A.BOT), 'bot-0804ccfb168c', '되돌린 판은 옛 본문(이름 = slug로 옮김)');
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  db.sql(`delete from public.msgr2_agents where id in ('${A.BOT}', '${A.BOT2}')`); // 시험 행 정리(시험 DB 안)
  run();
  assert.equal(v2(A.BOT), '-', '다시 적용하면 건너뛴다');
});
