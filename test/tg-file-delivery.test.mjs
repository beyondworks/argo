// 텔레그램 파일 전달(제보 2026-07-30: "파일을 안 보내준다") — ① 경로 추출이 산출물 구역
// 전체(projects/ 하위 폴더 포함)를 보는가 ② 탈출 거부 ③ 실패 비침묵 배선 ④ 규약 프롬프트 주입.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFileRefs, attachFailureNote } from '../src/tg-format.mjs';

test('extractFileRefs: projects/ 하위 폴더 산출물을 잡는다(프롬프트 지시와의 자기모순 해소)', () => {
  assert.deepEqual(
    extractFileRefs('완성했습니다: vault/projects/20260730_공공제안/제안서.pptx 확인해 주세요'),
    ['projects/20260730_공공제안/제안서.pptx'],
  );
  assert.deepEqual(extractFileRefs('files/보고서.pdf 입니다'), ['files/보고서.pdf']); // 기존 평면 유지
  assert.deepEqual(extractFileRefs('_imported/노트 (1).pdf'), ['_imported/노트 (1).pdf']);
  assert.deepEqual(extractFileRefs('깊게: projects/a/b/c/표.xlsx'), ['projects/a/b/c/표.xlsx']);
});

test('extractFileRefs: 탈출·빈 세그먼트 거부 + 상한 3개 + 중복 제거', () => {
  assert.deepEqual(extractFileRefs('files/../.secrets/키.zip'), []); // .. — 게이트웨이 직접 readFile이라 탈출 = vault 밖
  assert.deepEqual(extractFileRefs('projects//이중.pdf'), []); // 빈 세그먼트
  const many = extractFileRefs('files/a.pdf files/b.pdf files/c.pdf files/d.pdf files/a.pdf');
  assert.deepEqual(many, ['files/a.pdf', 'files/b.pdf', 'files/c.pdf']);
  assert.deepEqual(extractFileRefs('산출물 없는 평문'), []);
  assert.deepEqual(extractFileRefs('vault/notes/메모.md 언급'), []); // 첨부 구역 밖(기억) — 대상 아님
});

test('attachFailureNote: 실패 목록을 사용자 문장으로(빈 목록은 빈 문자열)', () => {
  assert.equal(attachFailureNote([], 'ko'), '');
  const ko = attachFailureNote([{ name: 'x.pptx', reason: '50MB 초과(텔레그램 봇 상한)' }], 'ko');
  assert.match(ko, /파일 첨부 실패/); assert.match(ko, /x\.pptx/); assert.match(ko, /50MB/);
  assert.match(attachFailureNote([{ name: 'a', reason: 'r' }], 'en'), /Could not attach/);
});

test('배선: 게이트웨이 발신이 실패를 수집·통보하고, 메신저 턴 프롬프트가 규약을 가르친다', async () => {
  const gw = await readFile(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  assert.match(gw, /if \(!res\.ok && isImagePath\(rel\)\) res = await send\('document'\)/, '사진 거절 문서 폴백');
  assert.match(gw, /attachFailureNote\(fails, lang\)/, '실패 비침묵 — 안내 발송');
  assert.match(gw, /50 \* 1024 \* 1024/, '봇 상한 사전 검사');
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  // SDK·CLI 두 프롬프트 조립 모두 주입 — 한쪽만 알면 러너별 편파(중립성 원칙).
  assert.equal(chat.split('${messengerNote}').length - 1 + chat.split('+ messengerNote').length - 1, 2, '두 경로 주입');
  assert.match(chat, /source === 'messenger'/, '메신저 턴 한정');
  assert.match(chat, /외부 발송이 아니다 — 결재 불필요/, '결재 오인 배제(스크린샷 케이스)');
});
