// 대화 대기열 — 답변 중에도 입력창을 잠그지 않는다(보내면 대기열로).
//
// 이 파일은 **소스 스캔 트립와이어**다(레포 선례: theme-graphite-sync·no-hardcoded-runner-label).
// 대상이 'use client' JSX라 노드 테스트로 렌더할 수단이 없어 동작을 직접 확인하지는 못한다 —
// 대신 "되돌리면 조용히 옛 동작으로 돌아가는 자리"만 골라 잠근다. 실제 동작(칩·자동 전송·정지)은
// 브라우저 확인이 정본이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
const composer = page.slice(page.indexOf('<textarea suppressHydrationWarning'));

test('입력창을 답변 중에 잠그지 않는다 — 잠금이 되살아나면 대기열은 도달 불가능해진다', () => {
  const tag = composer.slice(0, composer.indexOf('/>'));
  assert.doesNotMatch(tag, /disabled=\{busy\}/, 'textarea에 disabled={busy}가 다시 붙었다');
});

test('전송 버튼도 busy로 막지 않는다 — 막으면 Enter로만 대기열에 넣을 수 있다', () => {
  const btn = composer.slice(composer.indexOf('aria-label={busy ? t(\'chat.queue.add\')') - 200, composer.indexOf('aria-label={busy ? t(\'chat.queue.add\')'));
  assert.doesNotMatch(btn, /disabled=\{busy\b/);
});

test('답변 중 전송은 대기열로 간다 — 이 분기가 없으면 지시가 그냥 사라진다', () => {
  assert.match(page, /if \(busy\) \{ setQueue\(/);
});

test('실패·중단 턴은 대기열을 잠근다(자동 발사 금지) + 푸는 자리가 있다', () => {
  // 파일 어딘가에 setQueueHeld(true)가 있는지만 보면 **복원 이펙트의 것**으로 만족돼
  // 실패 경로의 잠금을 지워도 초록이었다(분리 검수 2026-08-03 M-2, 변이로 실증).
  // 그래서 sendMessage의 catch 블록 안에서 확인한다.
  const send = page.slice(page.indexOf('async function sendMessage'), page.indexOf('async function send(e)'));
  const katch = send.slice(send.indexOf('} catch (err) {'));
  assert.match(katch, /setQueueHeld\(true\)/, '실패 턴이 대기열을 잠그지 않는다 — 쌓인 지시가 줄줄이 나간다');
  // 잠금을 푸는 자리는 배출 이펙트와 버튼 둘뿐이어야 한다(sendMessage 진입부에서 풀면 무관한
  // 지시 하나로 대기열 전체가 발사된다 — M-1)
  assert.doesNotMatch(send.slice(0, send.indexOf('} catch (err) {')), /setQueueHeld\(false\)/);
  // 배출 조건이 그 잠금을 본다
  assert.match(page, /if \(busy \|\| uploading \|\| queueHeld \|\| !queue\.length\) return;/);
  // 사장이 직접 풀 수 있다 — 없으면 대기열이 영영 못 나가고 지우는 길밖에 없다
  assert.match(page, /chat\.queue\.sendNow/);
});

test('업로드가 끝나기 전에는 보내지 않는다 — 첨부가 조용히 떨어진다(Enter 경로 포함)', () => {
  const send = page.slice(page.indexOf('async function send(e)'));
  assert.match(send.slice(0, 900), /if \(uploading\) return;/);
});

test('새로고침 복원분은 잠긴 채 올라온다 — 보지도 않은 지시가 저 혼자 나가면 안 된다', () => {
  assert.match(page, /setQueue\(q\); setQueueHeld\(true\)/);
});

test('대기열은 기기 로컬이다 — 동기화되면 다른 기기에서 내가 안 보낸 지시가 나간다', () => {
  assert.match(page, /argo-queue:\$\{ws\}:\$\{slug\}/);
  // localStorage 외의 저장 경로(서버 PUT 등)가 붙지 않았는지 — 붙었다면 이 단언을 의도적으로 고칠 것
  assert.doesNotMatch(page, /queue.*api\(`\/api\/companies/);
});

test('대기열 문구는 ko·en 둘 다 등재된다(다국어 상시 규칙)', async () => {
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const key of ['chat.queue.label', 'chat.queue.add', 'chat.queue.remove', 'chat.queue.placeholder', 'chat.queue.held', 'chat.queue.sendNow']) {
    const line = i18n.split('\n').find((l) => l.includes(`'${key}'`));
    assert.ok(line, `${key} 미등재`);
    assert.match(line, /\[.+,.+\]/, `${key}에 두 언어가 다 있어야 한다`);
  }
});
