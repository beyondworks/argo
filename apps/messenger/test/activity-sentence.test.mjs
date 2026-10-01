// 점검 A·B #5 — 기억 탭 활동 기록에 "bot.create"·"invite.revoke" 같은 코드, 빈 "()", id 앞 8자리, "오프보딩·파견" 같은 전문어가 보이던 결함.
// 서버가 기록하는 모든 동작 코드(마이그레이션에서 읽는다)에 사람이 읽는 문장이 있는지, 모르는 코드는 일반 문구로 가는지를 행동으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { t as tm } from '../src/i18n.js';
import { activitySentence } from '../src/activity-sentence.mjs';

// 서버가 기록하는 동작 코드 — 마이그레이션의 msgr_audit(…, '코드') 호출과 직접 insert, 'approval.'·'doc.' 접두 조합
const migDir = new URL('../../../supabase/migrations/', import.meta.url);
const sql = readdirSync(migDir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, migDir), 'utf8')).join('\n');
const codes = new Set([...sql.matchAll(/msgr_audit\([^;]*/g)].flatMap((m) => [...m[0].matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((x) => x[1])));
for (const c of ['crew_left_with_owner', 'crew_removed_from_channel', 'approval.approved', 'approval.rejected', 'approval.pending', 'doc.insert', 'doc.update', 'doc.delete', 'node.bootstrap']) codes.add(c);

const res = {
  nameOfUser: (id) => (id === 'gone' ? '나간 사용자' : id === 'u2' ? '민수' : '유건'), chName: () => 'general', crewName: () => '서윤',
  docTitle: () => '회의록', roleName: (r) => ({ owner: '소유자', admin: '관리자', member: '멤버' }[r] ?? ''),
};
const make = (lang) => (r) => activitySentence({ r, t: (k, v) => tm(k, lang, v), lang, ...res });
const ko = make('ko'); const en = make('en');

const WORST = { id: 1, action: '', actor_user_id: 'u1', actor_crew_id: null, target_kind: 'bot', target_id: 'b-1', meta: {} };
const BAD = [/\b[a-z]+_?[a-z]*\.[a-z_.]{3,}\b/, /\(\s*\)/, /\{\w+\}/, /undefined|null|NaN/, /오프보딩|파견/, /\b[0-9a-f]{8}\b/];
const bad = (txt) => BAD.filter((re) => re.test(txt)).map(String);

test('서버가 기록하는 모든 동작 코드는 빈 meta여도 코드·빈 괄호·id·전문어 없이 읽힌다(한국어·영어)', () => {
  assert.ok(codes.size >= 30, `동작 코드 ${codes.size}개를 읽는다`);
  const failed = [];
  for (const action of [...codes].sort()) for (const [lang, fn] of [['ko', ko], ['en', en]]) {
    const txt = fn({ ...WORST, action });
    const why = bad(txt); if (why.length) failed.push(`${lang} ${action} → "${txt}" ${why.join(' ')}`);
  }
  assert.deepEqual(failed, []);
});

test('모르는 동작 코드는 코드 대신 일반 문구로', () => {
  assert.equal(ko({ ...WORST, action: 'zzz.future_thing' }), '유건이 설정을 바꿈');
  assert.equal(en({ ...WORST, action: 'zzz.future_thing' }), '유건 changed a setting');
});

test('봇 기록 문장 — 연결·이름 바꿈·연결 해제·토큰, 외부 에이전트 이름이 들어간다', () => {
  assert.equal(ko({ ...WORST, action: 'bot.create', meta: { name: '슈리', kind: 'hermes' } }), '유건이 외부 에이전트를 연결함: 슈리');
  assert.equal(ko({ ...WORST, action: 'bot.rename', meta: { name: 'QA 봇' } }), '유건이 외부 에이전트 이름을 바꿈: QA 봇');
  assert.equal(ko({ ...WORST, action: 'bot.revoke' }), '유건이 외부 에이전트 연결을 해제함');
  assert.equal(ko({ ...WORST, action: 'bot.rotate' }), '유건이 외부 에이전트의 토큰을 다시 만듦');
  assert.equal(ko({ ...WORST, action: 'invite.revoke', target_kind: 'invite' }), '유건이 초대 링크를 취소함');
});

test('회사 이메일 가입 — 도메인이 비면 "끔"이고 빈 괄호가 없다', () => {
  assert.equal(ko({ ...WORST, action: 'org.domain', target_kind: 'org', meta: { domain: null, role: 'member' } }), '유건이 회사 이메일로 가입하는 것을 끔');
  assert.equal(ko({ ...WORST, action: 'org.domain', target_kind: 'org', meta: { domain: 'example.test' } }), '유건이 회사 이메일 가입을 바꿈 (example.test)');
});

test('나간 사람 — 이름을 모르면 "나간 사용자", id 앞 8자리나 "오프보딩·파견"은 없다', () => {
  const left = ko({ id: 9, action: 'member.offboard', actor_user_id: null, target_kind: 'user', target_id: 'gone', meta: { crews_detached: 0 } });
  assert.equal(left, '나간 사용자가 조직에서 나감');
  assert.equal(ko({ id: 9, action: 'member.offboard', actor_user_id: null, target_kind: 'user', target_id: 'u2', meta: { crews_detached: 2 } }), '민수가 조직에서 나감 — 에이전트 2개도 함께 빠짐');
  assert.equal(ko({ id: 10, action: 'member.remove', actor_user_id: null, target_kind: 'user', target_id: 'gone', meta: {} }), '시스템이 나간 사용자를 조직에서 내보냄');
});

test('기존 문장은 그대로 — 멤버 역할 바꿈·초대 수락', () => {
  assert.equal(ko({ ...WORST, action: 'member.role', target_kind: 'user', target_id: 'u2', meta: { from: 'member', to: 'admin' } }), '유건이 민수를 멤버에서 관리자로 바꿈');
  assert.equal(ko({ ...WORST, action: 'invite.accept', target_kind: 'invite', meta: { role: 'member', channels: [] } }), '유건이 초대 링크로 들어옴 (멤버)');
});
