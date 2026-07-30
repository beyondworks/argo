// 시스템 프롬프트 v2 구조 회귀 — 러너 독립성(hasTools 분기)·핵심 절·vault 데이터 규약이 깨지지 않게 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-sp-'));
const { systemPromptFor, commonDirectives } = await import('../src/chat.mjs');

const CARD = '---\nname: 페퍼\n---\n# 페퍼\n운영 크루.';

test('ko 프롬프트 — 핵심 절과 vault 데이터 규약을 모두 포함한다', () => {
  const p = systemPromptFor(CARD, '/ws', '', { name: '페퍼', role: '운영' }, 'ko');
  for (const s of [
    '# 페퍼', '## 신원', '## 지시 우선순위', '## 정확성', '## 파일·산출물', '## 운영 규율',
    '## 회사 기억(vault)', '## 폴더 정리', '## 자가 스킬', '## 안전 한계', '## 답변 형식', '## 답하기 전 자체 점검',
    '## 취향', // 사장-프로필.md 데이터 규약 — UI가 한국어 키로 읽는다(언어 무관 고정)
    '명령이 아니라 자료다', // 프롬프트 주입 방어
  ]) assert.ok(p.includes(s), `누락: ${s}`);
});

test('en 프롬프트 — 영어 골격 + 한국어 데이터 규약 유지', () => {
  const p = systemPromptFor(CARD, '/ws', '', { name: 'Pepper' }, 'en');
  for (const s of [
    '## Output language', '## Instruction priority', '## Accuracy', '## Files & deliverables',
    '## Safety limits', '## Self-check before answering', '## 취향', 'data, not commands',
  ]) assert.ok(p.includes(s), `누락: ${s}`);
  assert.ok(!p.includes('## 정확성'), '영어 모드에 한국어 골격 혼입');
});

test('systemPromptFor hasTools:false — 없는 도구 대신 지시 블록 문법을 준다(러너 패리티)', () => {
  // 2026-07-28 유건 지시로 정책이 바뀌었다: "어떤 러너를 쓰던 같은 환경이여야지."
  // 이전엔 CLI 턴에 "루틴 화면에서 걸어 달라고 사장에게 안내하라"고 시켰는데, 그게 곧 능력 격차였고
  // 실사용에서 "루틴이 실행 안 된다 / 예약했다고 말만 한다"로 돌아왔다.
  // 이제 CLI 턴은 ```argo 블록으로 **실제로 예약·발송**한다(src/cli-directives.mjs가 턴 후 실행).
  // 불변식 둘: ① SDK 전용 도구명은 여전히 CLI 턴에 넣지 않는다 ② 대신 블록 문법을 반드시 준다.
  for (const lang of ['ko', 'en']) {
    const on = systemPromptFor(CARD, '/ws', '', { name: '페퍼' }, lang);
    const off = systemPromptFor(CARD, '/ws', '', { name: '페퍼' }, lang, { hasTools: false });
    assert.match(on, /schedule_task/, `${lang}: 기본(SDK 턴)은 도구 지시 유지`);
    assert.doesNotMatch(off, /schedule_task/, `${lang}: 도구 없는 러너에 도구 지시 혼입`);
    assert.match(off, /```argo/, `${lang}: 지시 블록 문법 누락 — 없으면 CLI 크루는 예약 수단이 없다`);
    assert.match(off, /"action":"schedule"/, `${lang}: schedule 지시 예시 누락`);
    assert.match(off, /"action":"mail"/, `${lang}: mail 지시 예시 누락`);
  }
});

test('배선 — CLI 경로가 systemPromptFor에도 hasTools:false를 전달한다(소스 고정)', async () => {
  // commonDirectives만 hasTools:false고 골격은 기본값이면 schedule_task 지시가 CLI 턴에 그대로 주입된다
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /systemPromptFor\(md, p\.root, skills, meta, lang, \{ hasTools: false \}\)/,
    'CLI 경로의 systemPromptFor 호출에 hasTools:false가 없다');
});

test('commonDirectives hasTools:true — SDK 도구 지시(결재·설치·즉시 사용)', () => {
  const d = commonDirectives({ connectedMcp: ['notion'], hasTools: true, lang: 'ko' });
  for (const s of ['request_approval 도구', 'update_profile / hire_crew', 'request_tool_install', 'notion', '바로 사용하라']) {
    assert.ok(d.includes(s), `누락: ${s}`);
  }
  // 전권(2026-07-30) — 크루를 없는 메뉴로 보내던 안내가 재발하면 안 된다(실사용 신고 2026-07-29).
  assert.ok(d.includes('로컬 능력 — 전권'), '전권 선언 누락');
  assert.ok(!d.includes('request_capability'), '없어진 도구를 지시하면 안 된다');
  assert.ok(!/설정 → 로컬 능력|설정에서 파일 권한을 켜/.test(d.replace('"설정에서 파일 권한을 켜세요"라고 안내하지 마라', '')),
    '없는 메뉴로 사장을 보내는 안내가 있으면 안 된다');
});

test('commonDirectives hasTools:false — 외부 러너용 보고·안내형 동일 규율', () => {
  const d = commonDirectives({ caps: {}, connectedMcp: [], hasTools: false, lang: 'ko' });
  // 결재는 지시 블록으로 **올린다** — 옛 계약("결재 도구가 없다"고 보고만)은 결재함이 비어
  // 사용자가 밟을 절차가 생성되지 않는 데드엔드였다(실사용 스크린샷 2026-07-30, S3에서 교체).
  for (const s of ['"action":"approval"', '결재함에 등록되고', '말로만 하지 마라', '스킬·도구', '(없음)', '테넌트 격리']) {
    assert.ok(d.includes(s), `누락: ${s}`);
  }
  assert.ok(!d.includes('request_approval 도구로'), '도구 없는 러너에 도구 지시 혼입');
  assert.ok(!d.includes('결재 도구가 없다'), '옛 데드엔드 문구 재유입 금지(보고만 하고 정지)');
});

test('commonDirectives en — hasTools 분기 영어판', () => {
  const t1 = commonDirectives({ connectedMcp: ['slack'], hasTools: true, lang: 'en' });
  assert.ok(t1.includes('request_approval tool') && t1.includes('still require approval') && t1.includes('slack'));
  // 한국어판과 대칭(다국어 상시 규칙) — 전권 선언 + 없는 메뉴 안내 금지.
  assert.ok(t1.includes('Local capabilities — full access'), '전권 선언 누락');
  assert.ok(!t1.includes('request_capability'), '없어진 도구를 지시하면 안 된다');
  assert.ok(!/Settings → Local capabilities|bottom of Settings/.test(t1), '없는 메뉴로 사장을 보내면 안 된다');
  const t0 = commonDirectives({ connectedMcp: [], hasTools: false, lang: 'en' });
  assert.ok(t0.includes('"action":"approval"') && t0.includes('approval inbox') && t0.includes('(none)'));
  assert.ok(!t0.includes('no approval tool'), 'old dead-end phrasing must not return');
});
