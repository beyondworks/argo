// 용어 변경 T3(크루→에이전트, rc-0195 terminology-plan.md 4-1) — 서버(SQL)와 본체(src/gateway/msgr.mjs)가 같은 안내 문장을 쓰는지 본다.
// 같은 상황(무료 기간 끝, AI 동의 안 함)에서 외부 봇 경로는 SQL 함수가, 본체 에이전트 경로는 msgr.mjs가 채널에 안내를 올린다.
// SQL은 "ko / en" 한 줄, msgr.mjs는 pick(ko, en, lang)으로 언어별로 고른다 — ko·en을 각각 비교한다.
// 기대 문장은 계획 4-1 표(T2b와 먼저 정한 문장)다. msgr.mjs 비교는 T2b가 문구를 바꾼 뒤(합친 뒤)부터 자동으로 켜진다.
// 실 Postgres 동작(안내가 실제로 새 문구로 올라가는지·client_msg_id 중복 방지)은 test/msgr-terms-agent-pg.test.mjs가 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOTICE } from './helpers/msgr-terms.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = `${ROOT}supabase/migrations/`;
const MIGS = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const TERMS_MIG = '20261006100000_msgr_terms_agent.sql';

const OLD = { paused: '크루 작업이 멈췄습니다', consent: '크루에게 맡길 수 있습니다' };

/** 함수의 마지막 정의(버전 순서상 가장 늦은 create or replace) 본문 */
function lastDef(name) {
  const head = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name.replace(/[$]/g, '\\$&')}\\s*\\(`, 'i');
  let found = null;
  for (const f of MIGS) {
    const src = readFileSync(MIG_DIR + f, 'utf8');
    const m = head.exec(src);
    if (!m) continue;
    const rest = src.slice(m.index);
    const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i)[1];
    const start = rest.indexOf(tag) + tag.length;
    found = { file: f, body: rest.slice(start, rest.indexOf(tag, start)) };
  }
  return found;
}
const literals = (body) => [...body.replace(/--[^\n]*/g, '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
const splitKoEn = (s) => { const [ko, en] = s.split(' / '); return { ko, en }; };

test('SQL 세 함수의 마지막 정의가 새 낱말을 쓴다(옛 크루 문구 없음)', () => {
  const before = lastDef('msgr_bot_updates_before_work');
  const personal = lastDef('_msgr_bot_personal_updates');
  const journal = lastDef('msgr_channel_journal');
  for (const d of [before, personal, journal]) assert.ok(d, '정의를 찾음');
  const lb = literals(before.body), lp = literals(personal.body), lj = literals(journal.body);
  const one = (lits, needle) => { const hit = lits.filter((s) => s.includes(needle)); assert.equal(hit.length, 1, `${needle} 1개`); return splitKoEn(hit[0]); };
  assert.deepEqual(one(lb, '무료 기간이 끝나'), NOTICE.paused, `${before.file} 무료 기간 안내`);
  assert.deepEqual(one(lb, '앱을 업데이트하고'), NOTICE.consent, `${before.file} AI 동의 안내`);
  assert.deepEqual(one(lp, '앱을 업데이트하고'), NOTICE.consent, `${personal.file} AI 동의 안내`);
  assert.equal(lj.filter((s) => s === '에이전트').length, 2, `${journal.file} 일지 대체 이름 2곳(요청한 에이전트·글 쓴 에이전트)`);
  for (const [d, lits] of [[before, lb], [personal, lp], [journal, lj]]) {
    assert.deepEqual(lits.filter((s) => /크루|사장|\bcrews?\b|captain/i.test(s.replace(/^crew$|^crew:%$/, ''))), [], `${d.file} 문자열에 옛 낱말 없음`);
  }
});

test('D1: 용어 마이그레이션은 이미 쌓인 행을 고치지 않는다(함수 본문 밖 UPDATE·DELETE·INSERT 0)', () => {
  const src = readFileSync(MIG_DIR + TERMS_MIG, 'utf8');
  const outside = src.replace(/(\$[a-z_]*\$)[\s\S]*?\1/gi, '').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(outside, /\b(update|delete|insert|truncate|alter\s+table|drop)\b/i);
  assert.match(outside, /create or replace function public\.msgr_bot_updates_before_work/);
  assert.equal([...outside.matchAll(/create or replace function/gi)].length, 3, '함수 3개만');
});

test('본체 msgr.mjs 안내 문구가 SQL과 같다(ko·en) — T2b를 합친 뒤 켜진다', (t) => {
  const src = readFileSync(`${ROOT}src/gateway/msgr.mjs`, 'utf8');
  if (src.includes(OLD.paused) && src.includes(OLD.consent)) {
    t.skip('msgr.mjs가 아직 옛 문구(T2b 합치기 전) — 합친 뒤 자동으로 켜진다');
    return;
  }
  for (const old of Object.values(OLD)) assert.ok(!src.includes(old), `msgr.mjs에 옛 문구 '${old}'가 남지 않음`);
  for (const [k, { ko, en }] of Object.entries(NOTICE)) {
    assert.ok(src.includes(ko), `msgr.mjs ${k} ko 문장이 SQL과 같다: ${ko}`);
    assert.ok(src.includes(en), `msgr.mjs ${k} en 문장이 SQL과 같다: ${en}`);
  }
});
