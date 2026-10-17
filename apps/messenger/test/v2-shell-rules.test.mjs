// 메신저 v2 모드(기존 셸 + v2 어댑터, U6c-1b) — 보내기 발송기, v2 표지(_v2)가 바꾸는 판정, App.jsx 연결 지점.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2ComposerTransport, v2Mentions, v2Files } from '../src/v2/composer.mjs';
import { crewAwayNotice } from '../src/crew-dm-notice.mjs';
import { canReportMessage } from '../src/report-target.mjs';
import { newChannelOffer } from '../src/onboard.mjs';
import { friendlyErr } from '../src/error-toast.mjs';
import { DICT } from '../src/i18n.js';

const A = 'a0000000-0000-4000-8000-000000000001';

test('발송기: 연결 상태 기계 send 한 번(글·멘션·파일·답글·client_msg_id), 파일 올리기·첨부 행 단계는 끝난 것으로', async () => {
  const sent = [];
  const machine = { send: async (x) => { sent.push(x); return { ok: true, id: 77, attachments: [] }; } };
  const tr = v2ComposerTransport(() => machine, { chId: 'room-1' });
  const file = { name: 'a.txt', type: 'text/plain', size: 3 };
  const id = await tr.message({ body: '@에이 해줘', clientId: 'cm-1', replyTo: 5, mentions: [{ kind: 'crew', id: A }, { kind: 'user', id: 'u' }, { kind: 'crew', id: A, role: 'cc' }], files: [{ file }] });
  assert.equal(id, 77);
  assert.deepEqual(sent, [{ roomId: 'room-1', body: '@에이 해줘', clientMsgId: 'cm-1', replyTo: 5, mentions: [A], files: [{ name: 'a.txt', mime: 'text/plain', bytes: 3, data: file }] }]);
  assert.deepEqual(await tr.upload(), { existed: true }); assert.equal(await tr.attachment(), undefined);
  assert.deepEqual(v2Mentions(Array.from({ length: 30 }, (_, i) => ({ kind: 'crew', id: `x${i}` }))).length, 20);
  assert.deepEqual(v2Files([{ file: { name: 'n' } }])[0].mime, 'application/octet-stream');
});

test('발송기: 다시 보내도 같은 거절은 영구 실패(실패 카드가 다시 보내기를 권하지 않는다), 다시 보낼 수 있는 코드·기계 없음은 보통 실패', async () => {
  const run = (code) => v2ComposerTransport(() => ({ send: async () => ({ ok: false, code }) }), { chId: 'r' }).message({ body: 'x', clientId: 'c', files: [] }).catch((e) => e);
  for (const [code, key] of [['rejected', 'msg.delivery.rejected'], ['invalid_attachment', 'msg.delivery.rejected'], ['service_paused', 'msg.delivery.rejected'], ['device_revoked', 'msg.delivery.authExpired'], ['login_required', 'msg.delivery.authExpired']]) {
    const e = await run(code); assert.equal(e.permanent, true, code); assert.equal(e.uiKey, key, code);
  }
  for (const code of ['rate_limited', 'internal', 'background']) { const e = await run(code); assert.equal(e.permanent, undefined, code); assert.equal(e.message, code); }
  const none = await v2ComposerTransport(() => null, { chId: 'r' }).message({ body: 'x', clientId: 'c', files: [] }).catch((e) => e);
  assert.match(none.message, /not ready/);
});

test('v2 표지(_v2): 에이전트 꺼짐 안내를 내지 않는다, v2 글도 신고할 수 있다(U6c-2b msgr2_report_message), v2 공간도 새 채널을 만든다 — 옛 행은 그대로', () => {
  const dm = { kind: 'dm' }; const old = { display_name: '에이', owner_user_id: 'me', last_seen_at: null };
  assert.ok(crewAwayNotice({ channel: dm, chCrews: [old], people: [], uid: 'me', now: Date.now(), awayMs: 90_000 }), '옛 에이전트는 그대로 꺼짐 안내');
  assert.equal(crewAwayNotice({ channel: dm, chCrews: [{ ...old, _v2: true }], people: [], uid: 'me', now: Date.now(), awayMs: 90_000 }), null);
  const msg = { author_kind: 'crew', crew_id: A };
  assert.equal(canReportMessage(msg, 'me'), true); assert.equal(canReportMessage({ ...msg, _v2: true }, 'me'), true);
  assert.equal(canReportMessage({ author_kind: 'system', _v2: true }, 'me'), false, 'v2 시스템 글은 신고 없음(서버 msgr2_report_no_message)');
  assert.equal(canReportMessage({ author_kind: 'user', author_user_id: 'me', _v2: true }, 'me'), false, '내 글(서버 msgr2_report_own)');
  assert.match(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), /unsupported: false \/\* v2 공간도 방을 만든다/, '셸은 v2 공간에도 새 채널을 켠다');
  assert.equal(newChannelOffer({ role: 'member' }).can, true); assert.equal(newChannelOffer({ role: 'member', unsupported: true }).can, false);
});

test('v2에서 아직 없는 기능(v2_unsupported)은 "곧 지원" 문구로(ko·en)', () => {
  const t = (k) => DICT[k]?.[0] ?? k; const en = (k) => DICT[k]?.[1] ?? k;
  assert.equal(friendlyErr('v2_unsupported', t), DICT['v2.unsupported'][0]); assert.equal(friendlyErr('v2_unsupported', en), DICT['v2.unsupported'][1]);
  assert.doesNotMatch(DICT['v2.unsupported'][1], /[가-힣]/);
});

test('App.jsx 연결: 플래그가 꺼지면 원래 클라이언트 그대로, 옛 실시간 효과는 v2에서 걸지 않는다, 입력창은 v2에서만 v2 발송기', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const supabase = V2 \? createV2ClientFor\(rawSupabase\) : rawSupabase;/);
  assert.match(app, /if \(!uid \|\| !hasToken \|\| !orgs\) return undefined;\n {4}if \(V2\) return undefined;/, '옛 org:·u: 구독');
  assert.match(app, /let live = true;[^\n]*\n {4}if \(V2\) return undefined;/, '옛 dm: 구독');
  assert.match(app, /V2 \? v2ComposerTransport\(\(\) => currentV2\(\)\?\.machine \?\? null, \{ chId \}\) \/\*[^*]*\*\/ : composerTransport\(supabase, \{ orgId, chId, uid,/);
  assert.doesNotMatch(app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\bwindow\.(confirm|prompt)\(/);
});
