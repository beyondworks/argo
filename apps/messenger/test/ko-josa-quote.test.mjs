// 조사 고르기 — 따옴표로 감싼 이름 뒤에도 받침을 본다(기능 점검 D6 카드: "'효일'을 '유건, 하나' 방에").
import test from 'node:test';
import assert from 'node:assert/strict';
import { koJosa } from '../src/ko-josa.mjs';

test("따옴표 뒤 조사 — 닫는 따옴표를 건너뛰고 그 앞 글자의 받침으로", () => {
  assert.equal(koJosa("'효일'을(를) 넣어"), "'효일'을 넣어");
  assert.equal(koJosa("'서윤'을(를) 넣어"), "'서윤'을 넣어");
  assert.equal(koJosa("'페퍼'을(를) 넣어"), "'페퍼'를 넣어");
  assert.equal(koJosa('“하나”이(가) 왔다'), '“하나”가 왔다');
  assert.equal(koJosa('효일이(가)'), '효일이', '따옴표 없는 종전 동작 그대로');
});
