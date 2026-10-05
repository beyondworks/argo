// UX 판독 UXM-05(2026-10-05): 오류 토스트가 서버·JS 원문('duplicate key value violates…', 'TypeError: …', 'Failed to fetch')을 그대로 보이고
// 다음 행동을 알려 주지 않았다. 원문을 넘기는 호출이 60곳이 넘어, 토스트를 그리는 한 곳에서 거른다: 연결 끊김 → 연결 안내, 아는 서버 코드 → 그 문구,
// 기계가 낸 원문 → '처리하지 못했습니다 … 진단' + 원문은 진단 기록에. 이미 번역해 넘긴 문구(사전)는 그대로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toastError, MACHINE_ERROR } from '../src/error-toast.mjs';
import { DICT, t as tm } from '../src/i18n.js';

for (const lang of ['ko', 'en']) {
  const t = (k, v) => tm(k, lang, v);
  test(`UXM-05 원문은 사용자 문구로 — ${lang}`, () => {
    assert.equal(toastError('TypeError: Failed to fetch', { t }), t('err.offline'));
    assert.equal(toastError('Load failed', { t }), t('err.offline'));
    assert.equal(toastError('new row violates row-level security policy for table "msgr_channels"', { t }), t('err.denied'));
    assert.equal(toastError('msgr_room_limit', { t }), t('room.limit'));
    for (const raw of ['duplicate key value violates unique constraint "msgr_channels_org_id_name_key"', "TypeError: Cannot read properties of undefined (reading 'id')", 'msgr_not_allowed', 'JWT expired', 'PGRST116: JSON object requested, multiple (or no) rows returned', 'Edge Function returned a non-2xx status code'])
      assert.equal(toastError(raw, { t }), t('err.raw'), raw);
    assert.notEqual(t('err.raw'), 'err.raw'); assert.notEqual(t('err.offline'), 'err.offline');
  });
}

test('UXM-05 이미 번역해 넘긴 사전 문구(ko·en 전부)는 기계 원문으로 보지 않는다', () => {
  const bad = [];
  for (const [k, [ko, en]] of Object.entries(DICT)) for (const v of [ko, en]) if (MACHINE_ERROR.test(v)) bad.push(`${k}: ${v}`);
  assert.deepEqual(bad, []);
  assert.equal(toastError(tm('err.denied', 'en'), { t: (k, v) => tm(k, 'en', v) }), tm('err.denied', 'en'));
  assert.equal(toastError('설정을 저장하지 못했습니다.', { t: (k, v) => tm(k, 'ko', v) }), '설정을 저장하지 못했습니다.');
});
