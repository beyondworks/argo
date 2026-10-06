// Intl.Segmenter가 없는 Node 빌드(--without-intl 셀프호스트)에서도 thread-context.mjs가 실리고 구획 맞춤이 대리 쌍을 가르지 않는다(5차 검수 '확인 안 함' 항목).
// 이 파일은 따로 도는 프로세스에서 모듈을 처음 싣기 전에 Segmenter를 지운다 — 다른 시험 파일과 같은 프로세스에 두면 이미 실린 모듈이라 의미가 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete globalThis.Intl.Segmenter;
const { fitContextSection, argvChars } = await import('../src/thread-context.mjs');

test('Segmenter 없음 — 모듈이 실리고, 요약은 자리 안에서 앞부분이 남고 외톨이 대리 문자를 만들지 않는다', () => {
  for (const room of [1000, 1001, 1002, 2000]) {
    const sec = fitContextSection({ lines: [], summary: '가😀'.repeat(3000) }, '최근 대화', 'ko', room);
    const got = JSON.parse(sec.split('\n').find((l) => l.startsWith('"')));
    assert.ok(argvChars(sec) + 1 <= room && got.length > 100, `room ${room}`);
    assert.ok(got.isWellFormed(), `room ${room}: 대리 쌍을 가르지 않는다`);
  }
});
