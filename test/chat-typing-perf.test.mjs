// 채팅 타이핑 지연 회귀 — 실사용 제보(2026-08-07 "채팅창 타이핑이 느리다", 특히 대화가 긴 크루).
//
// 뿌리: 채팅 화면은 입력 상태(input)와 메시지 목록이 **같은 컴포넌트**에 있어 키 한 타마다 스레드
// 전체가 재렌더된다. 그 자리에서 Markdown이 매번 marked.parse + 정규식 4회를 다시 돌면 그 비용이
// 전부 타이핑 지연이 된다.
//
// 실측(349메시지 스레드 · 크루 168건/117k자, 프로덕션 빌드 + 실브라우저):
//   수정 전: 키 1타 중앙값 450ms · 최대 1,711ms · **글자를 칠수록 증가**(111→1711)
//   수정 후: 중앙값 75ms · 최대 268ms · 증가 추세 소멸(평탄)
// 리플로우(자동 높이)·localStorage 초안 저장은 무죄로 확인(10회 0.3ms / 0ms).
//
// 이 파일은 그 수정(memo + useMemo)이 조용히 풀리는 것을 막는다 — 풀리면 지연이 그대로 돌아온다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../app/ui.jsx', import.meta.url), 'utf8');

test('Markdown이 memo로 감싸져 있다 — 텍스트가 그대로면 재렌더 자체를 건너뛴다', () => {
  assert.ok(/export const Markdown = memo\(/.test(ui),
    'Markdown은 memo로 export돼야 한다 — 풀면 키 입력마다 스레드 전체 재파싱');
  assert.ok(/^import \{[^}]*\bmemo\b/m.test(ui), 'memo 임포트');
});

test('파싱이 useMemo 안에 있다 — memo를 통과해 재렌더돼도 파싱은 안 돈다', () => {
  const body = ui.split('export const Markdown = memo(')[1]?.split('\n});')[0] ?? '';
  assert.ok(body, 'Markdown 본문 앵커');
  const memoAt = body.indexOf('useMemo(');
  const parseAt = body.indexOf('marked.parse(');
  assert.ok(memoAt >= 0, 'useMemo 사용');
  assert.ok(parseAt > memoAt, 'marked.parse가 useMemo 안에 있어야 한다(밖으로 나가면 매 렌더 재파싱)');
  assert.ok(/\}, \[text, wsId\]\)/.test(body), '의존성은 text·wsId — 둘이 그대로면 결과 재사용');
});

test('보안 처리가 메모 안으로 옮겨오며 유실되지 않았다', () => {
  const body = ui.split('export const Markdown = memo(')[1]?.split('\n});')[0] ?? '';
  // 이 4가지는 XSS·추적픽셀 방어 — 리팩터 중 조용히 빠지면 안 된다
  assert.ok(body.includes("replace(/</g, '&lt;')"), '< 이스케이프');
  assert.ok(body.includes('<img\\b[^>]*>'), '외부 이미지 제거');
  assert.ok(body.includes("rel=\"noopener noreferrer\""), '새 창 링크 안전 속성');
  assert.ok(body.includes('&quot;'), 'wikilink 속성 breakout 차단');
});
