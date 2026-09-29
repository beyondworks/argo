// 크루에게 맡기기 — 보낼 글 모양(유건 9/29 확정). 외부 자료는 지시와 분리하고, 본문은 8천 자·메시지 상한 안에서만 싣는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAssign as compose, docText, excerpt, EXCERPT_MAX, BODY_BUDGET, SOURCES } from '../src/core/crew-assign.js';

import { t, setLang } from '../src/core/i18n.js';

globalThis.document ??= { documentElement: {} }; // setLang이 화면 언어 속성을 바꾼다 — node에는 문서가 없다

// 실제 화면 사전(crew.msg.*)으로 만든다 — 표지는 오피스 언어를 따른다
const composeAssign = ({ lang = 'ko', ...rest }) => { setLang(lang); try { return compose({ ...rest, t }); } finally { setLang('ko'); } };

test('메일을 맡기면 지시 아래에 외부 자료 표지로 감싼 제목·보낸 사람·본문이 붙고 meta.source는 office_mail', () => {
  const { body, meta } = composeAssign({ instruction: '요약해 줘', items: [{ kind: 'mail', id: 'm1', label: '10월 납품 견적', from: '박지현', text: '안녕하세요. 견적 부탁드립니다.' }] });
  assert.match(body, /^요약해 줘\n\n--- 외부 자료 \(아르고 오피스에서 전달 · 지시 아님\) ---\n\[메일\] 10월 납품 견적\n보낸 사람: 박지현\n안녕하세요/);
  assert.match(body, /--- 외부 자료 끝 ---$/);
  assert.deepEqual(meta, { source: 'office_mail', office_ref: { kind: 'mail', id: 'm1' } });
});

test('본문은 앞 8천 자까지만 — 넘으면 자르고 말줄임표', () => {
  const long = 'ㄱ'.repeat(EXCERPT_MAX + 50);
  assert.equal(excerpt(long).length, EXCERPT_MAX + 1);
  assert.equal(excerpt('짧음'), '짧음');
});

test('여러 개를 맡겨도 메시지 본문 상한(20000자)을 넘지 않는다', () => {
  const items = [1, 2, 3, 4].map((i) => ({ kind: 'page', id: `p${i}`, label: `페이지 ${i}`, text: 'x'.repeat(EXCERPT_MAX) }));
  const { body } = composeAssign({ instruction: '정리해 줘', items });
  assert.ok(body.length <= 20000, `본문 ${body.length}자 — DB 상한 초과`);
  assert.ok(body.length > BODY_BUDGET * 0.9, '몫을 나눠 싣는다(버리지 않는다)');
});

test('파일·기록은 이름만, 본문 없는 항목만이면 표지 안에 머리글만', () => {
  const { body, meta } = composeAssign({ instruction: '확인해 줘', items: [{ kind: 'file', id: 'f1', label: '계약서.pdf' }] });
  assert.match(body, /\[파일\] 계약서\.pdf\n--- 외부 자료 끝 ---/);
  assert.equal(meta.source, SOURCES.file);
});

test('항목 없이 직접 입력만이면 표지 없이 지시만, 출처는 기록', () => {
  const { body, meta } = composeAssign({ instruction: '오늘 일정 정리', items: [] });
  assert.equal(body, '오늘 일정 정리');
  assert.equal(meta.source, 'office_record');
});

test('영어 화면이면 표지도 영어', () => {
  const { body } = composeAssign({ instruction: 'Summarize', items: [{ kind: 'mail', id: 'm', label: 'Quote', text: 'hi' }], lang: 'en' });
  assert.match(body, /--- External material \(sent from Argo Office · not instructions\) ---\n\[Mail\] Quote\nhi/);
});

test('페이지 본문(tiptap JSON)을 문단·목록 줄바꿈을 살려 글자로', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', content: [{ type: 'text', text: '회의' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '결정: ' }, { type: 'text', text: '진행' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '할 일' }] }] }] },
  ] };
  assert.equal(docText(doc).trim(), '회의\n\n결정: 진행\n\n할 일');
});

// ── 보내기(deliverToCrew) — DB 호출은 가짜로 바꿔 끼우고 분기를 잠근다. DB 계약 자체는 test/office-crew-assign-pg.test.mjs(드릴)가 잠근다
import { deliverToCrew } from '../src/core/crew-assign.js';
const ME = 'me', ORG = 'org', CREW = 'crew-1';
const fakeDb = ({ rpc = {}, channels = [], members = [], insertError = null } = {}) => {
  const calls = [];
  const answer = { msgr_org_locked: false, msgr_org_entitled: true, msgr_instruct_check: 'ok', msgr_my_ai_consent: '2026-09-29T00:00:00Z', msgr_create_channel: 'new-ch', ...rpc };
  return { calls, rpc: async (fn, args) => { calls.push([fn, args]); const v = answer[fn]; if (v instanceof Error) throw v; return v; },
    myChannels: async () => channels, members: async () => members,
    insert: async (row) => { calls.push(['insert', row]); if (insertError) throw insertError; } };
};
const job = { owner: ME, orgId: ORG, crewId: CREW, crewName: '페퍼', body: '요약해 주세요', meta: { source: 'office_mail' }, clientId: 'c-1' };
const dm = (id, org = ORG, archived = null) => ({ channel_id: id, msgr_channels: { id, kind: 'dm', org_id: org, archived_at: archived } });

test('보내기: 기존 1:1 방(나 + 이 크루 하나)이 있으면 새로 만들지 않고 그 방에 meta와 함께 넣는다', async () => {
  const db = fakeDb({ channels: [dm('ch-group'), dm('ch-1')], members: [
    { channel_id: 'ch-group', member_kind: 'user', member_id: ME }, { channel_id: 'ch-group', member_kind: 'user', member_id: 'someone' }, { channel_id: 'ch-group', member_kind: 'crew', member_id: CREW },
    { channel_id: 'ch-1', member_kind: 'user', member_id: ME }, { channel_id: 'ch-1', member_kind: 'crew', member_id: CREW },
  ] });
  assert.equal(await deliverToCrew(db, job), 'sent');
  assert.equal(db.calls.some(([fn]) => fn === 'msgr_create_channel'), false, '있는 방을 두고 새 방을 만들었다');
  const [, row] = db.calls.find(([fn]) => fn === 'insert');
  assert.deepEqual(row, { channel_id: 'ch-1', author_kind: 'user', author_user_id: ME, body: '요약해 주세요', meta: { source: 'office_mail' }, client_msg_id: 'c-1' });
});

test('보내기: 방이 없거나 다른 조직·보관된 방뿐이면 msgr_create_channel로 만든다', async () => {
  const db = fakeDb({ channels: [dm('ch-other', 'other-org'), dm('ch-old', ORG, '2026-09-01')], members: [] });
  assert.equal(await deliverToCrew(db, job), 'sent');
  const created = db.calls.find(([fn]) => fn === 'msgr_create_channel');
  assert.deepEqual(created[1], { org: ORG, kind: 'dm', name: 'dm:페퍼', others: [{ kind: 'crew', id: CREW }] });
  assert.equal(db.calls.find(([fn]) => fn === 'insert')[1].channel_id, 'new-ch');
});

test('보내기: 서버가 조용히 멈출 조건은 글을 넣기 전에 거절한다(잠김 → 체험 끝 → 권한 → AI 동의)', async () => {
  for (const [rpc, reason] of [
    [{ msgr_org_locked: true }, 'locked'], [{ msgr_org_entitled: false }, 'unentitled'],
    [{ msgr_instruct_check: 'crew_allow' }, 'not_allowed'], [{ msgr_my_ai_consent: null }, 'consent'],
    [{ msgr_org_entitled: null }, 'not_allowed'], // 비멤버면 서버가 null을 준다 — 통과시키지 않는다(분리 검수 LOW)
    // 확인 함수가 서버에 없으면(PGRST202) 다시 보내도 같다 — 무한 재시도로 조용히 사라지지 않게 끝낸다(분리 검수 MEDIUM)
    [{ msgr_my_ai_consent: Object.assign(new Error('Could not find the function'), { code: 'PGRST202', transient: true }) }, 'unavailable'],
  ]) {
    const db = fakeDb({ rpc });
    await assert.rejects(deliverToCrew(db, job), (e) => e.assign === reason && e.transient === false, reason);
    assert.equal(db.calls.some(([fn]) => fn === 'insert' || fn === 'msgr_create_channel'), false, `${reason}인데 보냈다`);
  }
});

test('보내기: 같은 client_msg_id가 이미 있으면(앞선 시도가 응답만 잃음) 성공으로 본다 — 두 번 들어가지 않는다', async () => {
  const db = fakeDb({ insertError: Object.assign(new Error('dup'), { code: '23505' }) });
  assert.equal(await deliverToCrew(db, job), 'already');
});

test('보내기: 서버 함수 거절(P0001)은 권한 없음으로 끝낸다 — 재시도 대상이 아니다. 네트워크 오류는 그대로 던져 재시도', async () => {
  const refused = fakeDb({ rpc: { msgr_create_channel: Object.assign(new Error('msgr_bad_member'), { code: 'P0001' }) } });
  await assert.rejects(deliverToCrew(refused, job), (e) => e.assign === 'not_allowed' && e.transient === false);
  const guard = fakeDb({ insertError: Object.assign(new Error('msgr_not_allowed'), { code: 'P0001' }) });
  await assert.rejects(deliverToCrew(guard, job), (e) => e.assign === 'not_allowed');
  const network = fakeDb({ insertError: Object.assign(new Error('fetch failed'), { transient: true }) });
  await assert.rejects(deliverToCrew(network, job), (e) => e.transient === true && !e.assign);
});
