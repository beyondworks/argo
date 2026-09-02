// 개인 스레드 맥락의 산출물 노트 — 크루가 앞 턴에 만든 파일을 다음 턴에서 "아까 그 파일"로 이어가려면 답변 텍스트가
// 아니라 경로로 받아야 한다(PR #399 분리 검수 LOW-2 관찰). 회의실 트랜스크립트(room.mjs)와 같은 형식·vault/ 접두.
// 맥락 빌더는 두 곳(외부 CLI 경로·SDK 기기 교차 경로)이 복제돼 있었다 → chat.mjs threadCtxLine 한 벌로.
// 잠그는 것: ① 헬퍼 순수 계약(ko/en·첨부→산출물 순서·500자 컷 바깥·없으면 노트 없음) ② 실제 CLI 턴(가짜 codex)이
// 받은 프롬프트에 노트가 실린다(ko·en 각각 — 행동) ③ 두 빌더가 헬퍼를 지난다(소스 핀 — SDK 교차 경로는 가짜로 못 돈다).
// ⚠ workspace.mjs의 WS_ROOT는 모듈 로드 시점에 고정 — env를 어떤 임포트보다 먼저 잡는다(실데이터 미접촉).
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-thread-ctx-'));
process.env.ARGO_ROOT = ROOT;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const mkws = async (ws, lang) => {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) {
    await mkdir(join(ROOT, ws, ...d), { recursive: true });
  }
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang, created: new Date().toISOString() }));
  await writeFile(join(ROOT, ws, 'agents', 'crew-a.md'), '---\nname: 크루A\nrunner: codex\n---\n\n전문가.\n');
  await writeFile(join(ROOT, ws, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
};

// 가짜 codex — 받은 프롬프트(runners.mjs가 `--` 뒤 마지막 인자로 넘긴다)를 .fake-prompts에 누적, 답변은 고정 문구.
// test/artifacts-behavior.test.mjs의 가짜 codex 하네스와 같은 형태(파일 산출은 없음 — 이 테스트의 관심은 프롬프트다).
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"; last="$a"
done
printf '%s\\n=====\\n' "$last" >> "$PWD/.fake-prompts"
[ -n "$OUT" ] && printf '이어서 정리했습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀) 우선 반전 후에도 가짜 codex가 잡히게 — 하네스 전용 해치

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { chat, threadCtxLine } = await import('../src/chat.mjs');
const { appendTurn } = await import('../src/thread.mjs');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false };
const ARTS = ['projects/20260902_보고/보고서.md', 'files/표.csv'];
const lastPrompt = async (ws) => (await readFile(join(ROOT, ws, '.fake-prompts'), 'utf8')).split('\n=====\n').filter(Boolean).at(-1);

test('threadCtxLine: 화자·본문 500자 컷·첨부→산출물 노트 순서(컷 바깥)·ko/en·없으면 노트 없음', () => {
  const long = '정리했습니다. ' + '가'.repeat(600); // 8자 + 600 → 컷 후 8자 + 가×492
  const m = { who: 'crew', text: long, attachments: [{ rel: 'files/a1_스케치.png', name: '스케치.png' }], artifacts: ARTS };
  assert.equal(threadCtxLine(m, 'ko', '크루A'),
    `크루A: 정리했습니다. ${'가'.repeat(492)} (첨부, Read로 열람: vault/files/a1_스케치.png) (산출물, Read로 열람: vault/projects/20260902_보고/보고서.md, vault/files/표.csv)`);
  assert.equal(threadCtxLine(m, 'en', 'CrewA'),
    `CrewA: 정리했습니다. ${'가'.repeat(492)} (attached, open with Read: vault/files/a1_스케치.png) (artifacts, open with Read: vault/projects/20260902_보고/보고서.md, vault/files/표.csv)`);
  // 기존 계약 유지(회귀 없음) — 화자 3종·노트 없음
  assert.equal(threadCtxLine({ who: 'user', text: '보고서  만들어줘' }, 'ko', '크루A'), '사장: 보고서 만들어줘');
  assert.equal(threadCtxLine({ who: 'user', text: 'do it', via: 'mail' }, 'en', 'CrewA'), 'Auto-delivered: do it');
  assert.equal(threadCtxLine({ who: 'crew', text: '넵', artifacts: [] }, 'ko', '크루A'), '크루A: 넵', '빈 배열이면 노트 없음');
});

test('CLI 턴(ko): 스레드에 남은 앞 턴 산출물이 다음 턴 프롬프트의 최근 대화에 경로 노트로 실린다', POSIX_ONLY, async () => {
  const WS = 'ctx-ko'; await mkws(WS, 'ko');
  await appendTurn(WS, 'crew-a', { userMsg: '보고서 만들어줘', reply: '만들었습니다', handover: null, sessionId: null, artifacts: ARTS });
  const r = await chat(WS, 'crew-a', '아까 그 파일 이어서 다듬어줘');
  assert.match(String(r.reply), /이어서 정리했습니다/);
  const p = await lastPrompt(WS);
  assert.match(p, /\n사장: 보고서 만들어줘\n크루A: 만들었습니다 \(산출물, Read로 열람: vault\/projects\/20260902_보고\/보고서\.md, vault\/files\/표\.csv\)\n/,
    '최근 대화 블록의 크루 줄 끝에 산출물 노트(vault/ 접두, 쉼표 나열)');
});

test('CLI 턴(en): 같은 노트가 영어 규약(attached/artifacts, open with Read)으로 실린다', POSIX_ONLY, async () => {
  const WS = 'ctx-en'; await mkws(WS, 'en');
  await appendTurn(WS, 'crew-a', { userMsg: 'make the report', reply: 'done', handover: null, sessionId: null, artifacts: [ARTS[0]] });
  await chat(WS, 'crew-a', 'polish that file');
  const p = await lastPrompt(WS);
  assert.match(p, /\nCaptain: make the report\n크루A: done \(artifacts, open with Read: vault\/projects\/20260902_보고\/보고서\.md\)\n/, 'en 라벨·en 노트');
  assert.doesNotMatch(p, /산출물, Read로 열람/, 'en 회사에 한국어 노트가 섞이지 않는다');
});

test('배선 — 두 맥락 빌더(CLI 경로·SDK 기기 교차 경로)가 threadCtxLine 한 벌을 지난다 [소스 구간 핀 — SDK 교차 경로는 가짜로 못 돈다]', async () => {
  const src = stripComments(await readFile(join(REPO, 'src/chat.mjs'), 'utf8'));
  const calls = src.match(/\.map\(\(m\) => threadCtxLine\(m, lang, meta\.name \|\| agentSlug\)\)/g) ?? [];
  assert.equal(calls.length, 2, 'CLI 경로 + SDK 기기 교차 경로 = 2곳(한 곳이 옛 인라인 식으로 돌아가면 노트가 그 경로에서만 사라진다). 정당한 새 호출부를 추가하거나 인자 형태를 바꾸면 이 숫자·앵커를 함께 갱신할 것 — 핀을 우회하지 말고(검수 LOW-1)');
  // 옛 인라인 식 부활 금지 — 노트 문구는 헬퍼 안에만 산다
  assert.equal((src.match(/첨부, Read로 열람/g) ?? []).length, 1, '첨부 노트 문구는 threadCtxLine 안 1곳');
  assert.equal((src.match(/산출물, Read로 열람/g) ?? []).length, 1, '산출물 노트 문구는 threadCtxLine 안 1곳');
  // 두 호출부가 각각 어느 구간에 있는지 — CLI(isCliRunner 블록)·SDK(crossCtx 블록)
  const cli = src.indexOf('if (isCliRunner(runner)) {'); const sdk = src.indexOf('let crossCtx = ');
  assert.ok(cli > 0 && sdk > cli, '두 블록 앵커');
  assert.ok(src.indexOf('threadCtxLine(m, lang', cli) < sdk, 'CLI 블록 안에 호출 1');
  assert.ok(src.indexOf('threadCtxLine(m, lang', sdk) > sdk, 'crossCtx 블록 안에 호출 2');
});
