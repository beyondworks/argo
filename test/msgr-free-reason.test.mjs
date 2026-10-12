// 본체 설정 카드의 연결이 무료 계정에서 멈춘 채 남았을 때의 이유(유건 2026-10-11 — app/api/companies/[ws]/msgr/free-reason.mjs).
// 잠그는 것: ① 이유 → 코드(limit → msgr_free_agent_limit, app·off → msgr_app_update_required, 이유 없음 → null)
// ② 서버가 이 기기의 새 앱을 모르면(app·off) 심박 한 번을 보내고 다시 판정 — 심박이 재개시켰으면 코드 없음 ③ 옛 서버(함수 없음)는 종전 is_pro 판정
// ④ 라우트가 이 함수를 쓰고, 서버 오류의 앞 코드(이유)를 msgr_pro_required보다 먼저 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freeAgentReason, swapNotes, readAgentPause, FREE_REASON_CODE } from '../app/api/companies/[ws]/msgr/free-reason.mjs';
import { pausedLabelKey } from '../app/c/[ws]/settings/msgr-card.mjs';
const { apiError, API_MSG } = await import('../app/apimsg.mjs');

const client = (seq, pro = false) => { const calls = []; return { calls, rpc: async (name) => { calls.push(name); if (name === 'is_pro') return { data: pro, error: null }; const next = seq.shift(); return next instanceof Error ? { data: null, error: { code: 'PGRST202', message: next.message } } : { data: next, error: null }; } }; };

test('① 이유 → 코드', async () => {
  assert.deepEqual(await freeAgentReason(client([{ paused: 1, active: 4, limit: 4, reason: 'limit' }])), { code: 'msgr_free_agent_limit', beaten: false });
  assert.deepEqual(await freeAgentReason(client([{ paused: 0, active: 2, limit: 4, reason: null }])), { code: null, beaten: false });
  for (const reason of ['app', 'off']) assert.deepEqual(await freeAgentReason(client([{ paused: 2, reason }, { paused: 2, reason }])), { code: 'msgr_app_update_required', beaten: false }, '심박을 못 보내면(기기 id 없음) 그대로');
});

test('② 새 앱이 아직 안 알려졌으면 심박 한 번 → 다시 판정(재개됐으면 코드 없음), limit이면 심박하지 않는다', async () => {
  let beats = 0; const beatNow = async () => { beats += 1; return true; };
  assert.deepEqual(await freeAgentReason(client([{ paused: 3, active: 0, reason: 'app' }, { paused: 0, active: 3, reason: null }]), { beatNow }), { code: null, beaten: true });
  assert.equal(beats, 1);
  assert.deepEqual(await freeAgentReason(client([{ paused: 3, reason: 'off' }, { paused: 3, reason: 'off' }]), { beatNow }), { code: 'msgr_app_update_required', beaten: true });
  await freeAgentReason(client([{ paused: 1, active: 4, reason: 'limit' }]), { beatNow });
  assert.equal(beats, 2, 'limit에는 심박이 소용없다');
  assert.deepEqual(await freeAgentReason(client([{ paused: 1, reason: 'app' }]), { beatNow: async () => { throw new Error('net'); } }), { code: 'msgr_app_update_required', beaten: false }, '심박 실패는 삼키고 첫 판정으로');
});

test('③ 옛 서버(msgr_my_agent_pause 없음) — 종전 is_pro 판정', async () => {
  const c1 = client([new Error('Could not find the function')], false);
  assert.deepEqual(await freeAgentReason(c1), { code: 'msgr_pro_required', beaten: false });
  assert.deepEqual(c1.calls, ['msgr_my_agent_pause', 'is_pro']);
  assert.deepEqual(await freeAgentReason(client([new Error('x')], true)), { code: null, beaten: false });
});

test('④ 라우트 배선 + 코드가 ko·en 사전에 있다', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  assert.equal((route.match(/await freeAgentReasonFor\(c, ws\)/g) ?? []).length, 3, '연결 세 갈래(일괄 activate·개인 공간 activate·단일 POST)');
  assert.ok(route.indexOf('/msgr_free_agent_limit/.test(m)') < route.indexOf('/msgr_pro_required/.test(m)'), '앞 코드(이유)를 먼저 본다');
  assert.ok(route.indexOf('/msgr_app_update_required/.test(m)') < route.indexOf('/msgr_pro_required/.test(m)'));
  for (const code of ['msgr_free_agent_limit', 'msgr_app_update_required']) for (const lang of ['ko', 'en']) assert.equal(apiError(code, lang).status, 403);
});

test('⑤ 교체 안내·이유 읽기(검수 #945) — 이름은 중복 없이, 옛 서버면 빈 목록·null, 행이 없으면 요청 0', async () => {
  const calls = [];
  const c = { rpc: async (name, args) => { calls.push([name, args]); return name === 'msgr_agent_swap_notes' ? { data: [{ crew_id: 'a', victim_name: '준' }, { crew_id: 'b', victim_name: '준' }, { crew_id: 'c', victim_name: '미아' }], error: null } : { data: { reason: 'limit', min_app: '0.1.102' }, error: null }; } };
  assert.deepEqual(await swapNotes(c, ['a', 'b', 'c']), ['준', '미아']);
  assert.deepEqual(calls[0], ['msgr_agent_swap_notes', { p_crews: ['a', 'b', 'c'] }]);
  assert.deepEqual(await swapNotes(c, []), []); assert.equal(calls.length, 1);
  assert.deepEqual(await swapNotes({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }, ['a']), []);
  assert.deepEqual(await readAgentPause(c), { reason: 'limit', min_app: '0.1.102' });
  assert.equal(await readAgentPause({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }), null);
});

test('⑥ 라우트 배선(검수 #945) — 새 행은 연결 해제로 먼저 넣고 연결(사람의 연결 판정), 교체 안내를 응답에, 멈춘 회사 브리지는 최소 버전 이상일 때만', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  const act = route.slice(route.indexOf('if (activate) {'), route.indexOf('return Response.json({ ok: true, crews, swapped });'));
  assert.match(act, /status: 'paused', allow: 'owner'/, '새 행은 paused로 insert — 새 앱이 없어 연결이 거절돼도 파견 해제(available)로 남지 않고, 새 앱 심박 뒤 재개(분리 검수 3차 ①)');
  assert.doesNotMatch(act, /status: 'available', allow: 'owner'/, 'available로 넣으면 거절 때 해제된 행으로 남는다(9cbc1f2e)');
  assert.doesNotMatch(act, /status: 'active', allow: 'owner'/, 'active로 바로 넣지 않는다(미러 insert와 구별되지 않는다)');
  assert.ok(act.indexOf("insert(row)") < act.indexOf('beatNow(c, ws)') && act.indexOf('beatNow(c, ws)') < act.indexOf("update({ ...base, status: 'active' })"), '넣기 → 새 앱 심박 → 연결 순서');
  assert.equal(FREE_REASON_CODE.room, undefined, "room(자리 남음)은 오류가 아니다 — 연결 결과에 오류 코드를 붙이지 않는다");
  assert.match(route, /let enabled = regs\.some\(\(r\) => r\.status === 'active'\);\n\s+if \(!enabled && regs\.some\(\(r\) => r\.status === 'paused'\)\) enabled = appMeetsMin\(/);
});

test('⑦ 화면 검수 B(10/11) — 연결 카드의 멈춘 행은 "파견 해제됨"이 아니라 멈춤 + 이유, 교체 안내는 대기 표시와 다른 말(멈췄어요), 이유 읽기는 멈춘 행이 있을 때만', () => {
  assert.equal(pausedLabelKey('limit'), 'settings.msgr.paused.limit');
  for (const r of ['app', 'off']) assert.equal(pausedLabelKey(r), 'settings.msgr.paused.app');
  assert.equal(pausedLabelKey('room'), 'settings.msgr.paused.room', '새 앱 켜짐 + 자리 남음(분리 검수 3차 ③)');
  for (const r of [null, undefined, 'weird']) assert.equal(pausedLabelKey(r), 'settings.msgr.paused', '이유를 모르면(Pro로 바뀌는 중·옛 서버) 멈춤만');
  const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const entry = (k) => { const m = dict.match(new RegExp(`'${k.replace(/\./g, '\\.')}': \\['([^']*)', '([^']*)'\\]`)); return m ? { ko: m[1], en: m[2] } : null; };
  assert.deepEqual(entry('settings.msgr.paused.limit'), { ko: '멈춤 · 무료 4명 한도', en: 'Paused · Free plan limit of 4' });
  assert.deepEqual(entry('settings.msgr.paused.room'), { ko: '멈춤 · 지금 연결할 수 있어요', en: 'Paused · You can connect it now' });
  for (const k of ['settings.msgr.paused', 'settings.msgr.paused.app']) { const e = entry(k); assert.match(e.ko, /^멈춤/); assert.match(e.en, /^Paused/); }
  for (const k of ['settings.msgr.paused', 'settings.msgr.paused.limit', 'settings.msgr.paused.app']) assert.doesNotMatch(entry(k).ko, /해제/, `${k}: 사용자가 해제한 것처럼 읽히지 않게`);
  assert.equal(entry('settings.msgr.notRegistered').ko, '파견 해제됨', '사람이 해제한 행(available)은 그대로');
  const sw = entry('settings.msgr.swapped');
  assert.match(sw.ko, /멈췄어요/); assert.doesNotMatch(sw.ko, /쉬/, '교체 안내는 대기 표시(쉬는 중)와 겹치지 않는 말'); assert.match(sw.en, /paused/);
  assert.doesNotMatch(API_MSG.msgr_free_agent_limit.ko, /쉬/);
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /row\?\.status === 'paused' \? t\(pausedLabelKey\(st\?\.pauseReason\)\)/, '카드 줄: 멈춘 행이면 멈춤 문구');
  const act = page.slice(page.indexOf('async function connectAgents('), page.indexOf('finally { setActivating(false); }', page.indexOf('async function connectAgents(')));
  assert.match(act.slice(act.indexOf('catch (e)')), /load\(\)/, '연결이 거절돼도 다시 읽는다 — 행은 멈춤으로 들어갔으니 "메신저에 아직 없음"으로 남지 않게(분리 검수 3차 화면 확인)');
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  assert.match(get, /\[\.\.\.crews, \.\.\.personal\]\.some\(\(r\) => r\.status === 'paused'\) \? \(await readAgentPause\(c\.client\)\.catch\(\(\) => null\)\)\?\.reason \?\? null : null/, '이유 읽기는 멈춘 행(조직·개인)이 있을 때만(8초 폴에 호출을 늘리지 않게)');
});

test('⑧ 검수 스택 화면 4차 — 개인 공간 연결(조직 없음)·교체 미리 알림: 라우트는 개인 행을 넣지 않고 멈춤·해제 행만 연결, 미리 알림은 서버 RPC, 카드는 미리 알림 뒤 확인을 받고 연결', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  const per = route.slice(route.indexOf('if (activate && personal) {'), route.indexOf('return Response.json({ ok: true, personal'));
  assert.ok(per.length > 0, '개인 공간 연결 갈래');
  assert.doesNotMatch(per, /\.insert\(/, '개인 행은 미러(게이트웨이)가 만든다 — 여기서 넣지 않는다');
  assert.match(per, /\.update\(\{ status: 'active' \}\)/, '상태만 바꾼다(허용 범위·이름 보존)');
  assert.match(per, /if \(r\.status !== 'paused'\) continue;/, '멈춘 행만 — 사람이 해제한(available) 개인 에이전트를 다시 켜지 않는다(재검수 LOW-1)');
  assert.doesNotMatch(per, /'available'/);
  assert.match(route, /async function myPersonalRows\(c, ws\)[\s\S]{0,400}\.is\('org_id', null\)/, '개인 행 = org_id NULL');
  assert.match(route, /if \(preview\) \{[\s\S]{0,600}rpc\('msgr_free_swap_preview', \{ p_ws: ws, p_slugs: known \}\)/, '미리 알림은 서버가 관문과 같은 순서로');
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('async function connectAgents('), page.indexOf('finally { setActivating(false); }', page.indexOf('async function connectAgents(')));
  assert.ok(fn.indexOf('preview: true') > 0 && fn.indexOf('preview: true') < fn.indexOf('activate: true'), '연결 전에 미리 알림');
  assert.match(fn, /if \(!confirmed\) \{\s*const p = await api\(`\/api\/companies\/\$\{ws\}\/msgr`, \{ preview: true, slugs \}\)/, '확인 전에는 늘 미리 알림을 묻는다');
  assert.match(fn, /if \(p\?\.victims\?\.length\) \{[^\n]*\n\s*if \(await openKeep\(scope, slugs\)\) return;\s*\n\s*setConfirm\(/, '멈출 에이전트가 있으면 유지할 에이전트 고르기부터, 못 열면 종전 확인(2026-10-12 — 일괄 연결이 목록 끝 4명만 남기던 제보)');
  assert.match(page, /connectAgents\(\{ personal: true \}, personalView\.missing\)/, '개인 공간 카드의 연결');
  assert.match(page, /connectAgents\(\{ orgId \}, missing\.map\(\(agent\) => agent\.slug\)\)/, '조직 카드의 연결도 같은 길');
  const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['settings.msgr.swap.confirm', 'settings.msgr.swap.go', 'settings.msgr.personal.title', 'settings.msgr.personal.status', 'settings.msgr.personal.rosterHelp', 'settings.msgr.personal.count'])
    assert.match(dict, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});
