// 메신저 v2 연결(U5) 순수 규칙 — 재연결 간격 상한, 거부 코드 → 다시 보낼지(약속 retry 표시), 최소 버전, 따라잡기 응답 정리.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REJECT_CODES } from '../../../packages/agent-link/contract/v1.mjs';
import { backoffDelay, belowMin, rejectCodeOf, retryable, normalizeCatchUp, uploadPath, RECONNECT, SEND_RETRY, pausedOf, deviceIdOf, ATTACH_LIMITS, attachName, attachmentProblem } from '../src/link/policy.mjs';
import { readFileSync } from 'node:fs';

test('재연결 간격: 지수로 늘고 상한(60초)을 넘지 않는다, 흔들기는 절반~전부', () => {
  const full = () => 0.999999;
  const seq = Array.from({ length: 12 }, (_, n) => backoffDelay(n, RECONNECT, full));
  assert.deepEqual(seq.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  for (const d of seq) assert.ok(d <= RECONNECT.maxMs, `상한 초과 ${d}`);
  assert.equal(backoffDelay(3, RECONNECT, () => 0), 4000, '흔들기 최소 = 절반');
  assert.equal(backoffDelay(40, RECONNECT, full), 60000, '큰 n도 상한');
  assert.ok(backoffDelay(10, SEND_RETRY, full) <= SEND_RETRY.maxMs);
});

test('다시 보낼 코드는 약속의 retry 표시를 따른다 — rate_limited·internal뿐', () => {
  const yes = Object.keys(REJECT_CODES).filter(retryable).sort();
  assert.deepEqual(yes, ['internal', 'rate_limited']);
  for (const c of ['duplicate', 'rejected', 'update_required', 'not_registered', 'device_revoked', 'service_paused']) assert.equal(retryable(c), false, c);
});

test('서버 오류 → 거부 코드', () => {
  assert.equal(rejectCodeOf(null), null);
  assert.equal(rejectCodeOf({ code: '23505', message: 'duplicate key value violates unique constraint "msgr2_messages_client"' }, 409), 'duplicate');
  assert.equal(rejectCodeOf({ code: '23503', message: 'insert or update violates foreign key constraint' }, 409), 'rejected', 'REST 409(외래 키)는 중복이 아니다');
  assert.equal(rejectCodeOf({ message: 'The resource already exists', status: 409, statusCode: '409' }, undefined, { storage: true }), 'duplicate');
  assert.equal(rejectCodeOf({ code: 'P0001', message: 'device_revoked' }, 400), 'device_revoked');
  assert.equal(rejectCodeOf({ code: '42501', message: 'msgr2_device_invalid' }, 403), 'device_unknown');
  assert.equal(rejectCodeOf({ code: 'P0001', message: 'service_paused' }, 400), 'service_paused');
  assert.equal(rejectCodeOf({ code: 'P0001', message: 'app_version_unsupported' }, 400), 'update_required');
  assert.equal(rejectCodeOf({ message: 'Too Many Requests' }, 429), 'rate_limited');
  assert.equal(rejectCodeOf({ message: 'upstream' }, 503), 'internal');
  assert.equal(rejectCodeOf({ code: '57014', message: 'canceling statement due to statement timeout' }, 400), 'internal');
  assert.equal(rejectCodeOf({ message: 'TypeError: Failed to fetch', code: '' }, 0), 'internal');
  assert.equal(rejectCodeOf({ name: 'StorageUnknownError', message: 'fetch failed' }, undefined, { storage: true }), 'internal');
  assert.equal(rejectCodeOf({ code: '42501', message: 'new row violates row-level security policy' }, 403), 'rejected', '모르는 거부는 다시 보내지 않는다');
  // U3 등록 거부(…_msgr2_device.sql): 다시 로그인 3종, 값 모양 22023은 기기 무효와 가른다
  assert.equal(rejectCodeOf({ code: '42501', message: 'device_login_required' }, 403), 'login_required');
  assert.equal(rejectCodeOf({ code: '42501', message: 'msgr2_session_required' }, 403), 'login_required');
  assert.equal(rejectCodeOf({ code: '42501', message: 'msgr2_device_kind_locked' }, 403), 'login_required');
  assert.equal(rejectCodeOf({ code: '22023', message: 'msgr2_device_invalid' }, 400), 'invalid');
  assert.equal(rejectCodeOf({ code: '42501', message: 'device_expired' }, 403), 'device_expired');
  assert.equal(rejectCodeOf({ code: 'PGRST301', message: 'JWT expired' }, 401), 'rejected', '만료 토큰은 기계가 간격 두고 다시 붙는다(코드는 rejected)');
});

test('최소 버전: 아래면 참, 같거나 위·값 없음·앱 버전 모름은 거짓', () => {
  assert.equal(belowMin('0.1.63', '0.2.0'), true);
  assert.equal(belowMin('0.2.0', '0.2.0'), false);
  assert.equal(belowMin('0.2.1', '0.2.0'), false);
  assert.equal(belowMin('0.1.63', null), false);
  assert.equal(belowMin(null, '0.2.0'), false);
  assert.equal(belowMin('0.0.0', '0.2.0'), false);
});

test('따라잡기 응답: 방별 묶음·id 오름차순·200 넘으면 더 있음(두 모양 모두)', () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: 1000 - i, room_id: 'A' })).concat([{ id: 5, room_id: 'B' }]);
  const flat = normalizeCatchUp(rows);
  const a = flat.rooms.find((r) => r.roomId === 'A');
  assert.equal(a.messages.length, 200); assert.equal(a.more, true);
  assert.equal(a.messages[0].id, 801); assert.equal(a.messages.at(-1).id, 1000, '최근 200개를 남긴다');
  assert.equal(flat.rooms.find((r) => r.roomId === 'B').more, false);
  const obj = normalizeCatchUp({ rooms: [{ room_id: 'A', messages: [{ id: 3 }, { id: 2 }], more: true }], paused: false });
  assert.deepEqual(obj.rooms[0].messages.map((m) => m.id), [2, 3]); assert.equal(obj.rooms[0].more, true); assert.equal(obj.paused, false);
  assert.equal(normalizeCatchUp({ rooms: [], paused: true }).paused, true);
  assert.deepEqual(normalizeCatchUp(null), { rooms: [], paused: false, nextSince: null });
  // U2 next_since: 안전 정수만 받고, 옛 서버(값 없음)·이상한 값은 null
  assert.equal(normalizeCatchUp({ rooms: [], next_since: 42 }).nextSince, 42);
  for (const v of [undefined, null, -1, 1.5, '42x', 2 ** 53]) assert.equal(normalizeCatchUp({ rooms: [], next_since: v }).nextSince, null, String(v));
});

test('작은 읽기: 중단 표지·기기 id·업로드 경로(같은 글의 같은 파일 = 같은 경로)', () => {
  assert.equal(pausedOf(null), false); assert.equal(pausedOf({ paused: true, since: 'x' }), true); assert.equal(pausedOf({ paused: false }), false);
  assert.equal(deviceIdOf('d1'), 'd1'); assert.equal(deviceIdOf({ device_id: 'd2' }), 'd2'); assert.equal(deviceIdOf(null), null);
  assert.equal(uploadPath('r', 'c', 0, 'a/b.png'), 'r/c/0-a_b.png');
  assert.equal(uploadPath('r', 'c', 1, 'x.txt'), uploadPath('r', 'c', 1, 'x.txt'));
});

test('첨부 제한(#1077 검수 3) — 서버 msgr2_attachment_add와 같은 값·같은 이름 정리', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/20261018000000_msgr2_work.sql', import.meta.url), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.msgr2_attachment_add('), sql.indexOf('end $$;', sql.indexOf('create or replace function public.msgr2_attachment_add(')));
  assert.match(fn, new RegExp(`p_index not between 0 and ${ATTACH_LIMITS.maxFiles - 1}\\b`), '파일 수');
  assert.match(fn, new RegExp(`char_length\\(nm\\) > ${ATTACH_LIMITS.maxName}\\b`), '이름 길이');
  assert.match(fn, new RegExp(`p_bytes not between 0 and ${ATTACH_LIMITS.maxBytes}\\b`), '크기');
  assert.match(fn, /nm in \('', '\.'\)/, "빈 이름·'.' 거부");
  assert.equal(attachName('a/b\\c..d\u0001e'), 'a_b_c_d_e');
  assert.equal(attachmentProblem([{ name: 'ok.txt', bytes: 0 }]), null);
  assert.equal(attachmentProblem([{ name: '..', bytes: 1 }]), null, "'..'은 '_'가 되어 통과(서버와 같다)");
  assert.equal(attachmentProblem([{ name: '.', bytes: 1 }]), 'invalid_attachment');
  assert.equal(attachmentProblem([{ name: 'x', bytes: -1 }]), 'invalid_attachment');
});
