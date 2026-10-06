// Postgres·PostgREST·네트워크 오류 분류(검수 #fix-cross 4차 M-1) — 일시 오류만 좁게 나열한다(다음 틱에 다시), 나머지는 결정적(백오프)이다.
// 일시 오류를 넓게 잡으면 목록에 없던 결정적 오류(PGRST204·22P05·42P10·42703)가 15초마다 되풀이됐다. 스키마 어긋남(PGRST202·204·205·42883·42703·42P01)은 따로 가른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientDbError, isSchemaSkewError, isDeterministicDbError } from '../src/pg-error-class.mjs';

const E = (code, message = 'x', extra = {}) => Object.assign(new Error(message), code === undefined ? {} : { code }, extra);

test('P1. 일시 오류 — 코드 없음(fetch failed·시간 초과)·네트워크 코드·PGRST0xx(연결)·PGRST3xx(JWT)·08xxx·40001·40P01·40003·53xxx·55P03·57014·57P01·57P03·57P05·5xx·402·408·429', () => {
  const transient = [E(undefined, 'TypeError: fetch failed'), E('', 'x'), E('PGRST000'), E('PGRST001'), E('PGRST003'), E('PGRST300'), E('PGRST301'), E('08006'), E('08001'), E('40001'), E('40P01'), E('53300'), E('53200'), E('57014'), E('57P01'), E('57P03'), E('57P05'), E('55P03'), E('40003'),
    E('500'), E('502'), E('503'), E('504'), E('402'), E('408'), E('429'), E('ECONNRESET'), E('ETIMEDOUT'), E('ENOTFOUND'), E('EAI_AGAIN'), E('UND_ERR_CONNECT_TIMEOUT'),
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), Object.assign(new Error('timeout'), { name: 'TimeoutError' }), null, undefined];
  for (const e of transient) { assert.equal(isTransientDbError(e), true, `${e?.code ?? e?.name ?? e}: 일시`); assert.equal(isDeterministicDbError(e), false); }
});

test('P2. 결정적 오류 — 목록에 없는 코드는 결정적(RLS 42501·제약 23xxx·22xxx·42xxx·P0001·P0002·0A000·XX000·25006·25P02·21000·28xxx·54000·PGRST1xx/2xx — 검수 5차)', () => {
  const det = ['42501', '23502', '23503', '23505', '23514', '23P01', '22P02', '22P05', '22001', '22003', '42P10', '42703', '42883', '42P01', '42601', 'P0001', 'P0002', '0A000', 'XX000', '25006', '25P02', '21000', '28000', '28P01', '54000', '57P04', 'PGRST100', 'PGRST102', 'PGRST116', 'PGRST202', 'PGRST204', 'PGRST205', '400', '401', '403', '404', '409'];
  for (const c of det) { assert.equal(isTransientDbError(E(c)), false, `${c}: 결정적`); assert.equal(isDeterministicDbError(E(c)), true); }
});

test('P3. 스키마 어긋남 — PGRST202·204·205·42883·42703·42P01만(앱이 마이그레이션보다 먼저 나갔다) — 결정적이기도 하다', () => {
  for (const c of ['PGRST202', 'PGRST204', 'PGRST205', '42883', '42703', '42P01']) { assert.equal(isSchemaSkewError(E(c)), true, c); assert.equal(isDeterministicDbError(E(c)), true, c); }
  for (const c of ['42501', '23505', '22P05', 'P0001', 'PGRST100', 'PGRST000', '42P10', undefined, '']) assert.equal(isSchemaSkewError(E(c)), false, String(c));
});
