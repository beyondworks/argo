// 개인 스레드 맥락의 산출물 노트 — 크루가 앞 턴에 만든 파일을 다음 턴에서 "아까 그 파일"로 이어가려면 답변 텍스트가
// 아니라 경로로 받아야 한다(PR #399 분리 검수 LOW-2 관찰). 회의실 트랜스크립트(room.mjs)와 같은 형식·vault/ 접두.
// 맥락 빌더는 두 곳(외부 CLI 경로·SDK 기기 교차 경로)이 복제돼 있었다 → chat.mjs threadCtxLine 한 벌로.
// 잠그는 것: ① 헬퍼 순수 계약(ko/en·첨부→산출물 순서·500자 컷 바깥·없으면 노트 없음) ② 실제 CLI 턴(가짜 codex)이
// 받은 프롬프트에 노트가 실린다(ko·en 각각 — 행동) ③ 두 빌더가 헬퍼를 지난다(소스 핀 — SDK 교차 경로는 가짜로 못 돈다).
// ⚠ workspace.mjs의 WS_ROOT는 모듈 로드 시점에 고정 — env를 어떤 임포트보다 먼저 잡는다(실데이터 미접촉).
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
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
[ "$last" = "-" ] && last="$(cat)" # 진짜 codex exec 계약: 프롬프트 자리가 - 면 stdin에서 읽는다(K01 — 러너가 프롬프트를 stdin으로 넘긴다)
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
const { msgrHead } = await import('../src/inbound-marks.mjs');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false };
const ARTS = ['projects/20260902_보고/보고서.md', 'files/표.csv'];
const lastPrompt = async (ws) => (await readFile(join(ROOT, ws, '.fake-prompts'), 'utf8')).split('\n=====\n').filter(Boolean).at(-1);

test('threadCtxLine: 항목 JSON 배열 한 줄 [누가, 원문, 보낸 곳?, 덧붙임?] — 본문 500자 컷(원문 그대로)·첨부→산출물 경로(덧붙임 files·made, 컷 바깥)·언어 무관·없으면 칸 없음', () => {
  const long = '정리했습니다. ' + '가'.repeat(600); // 8자 + 600 → 컷 후 500자
  const m = { who: 'crew', text: long, attachments: [{ rel: 'files/a1_스케치.png', name: '스케치.png' }], artifacts: ARTS };
  const want = ['crew', long.slice(0, 500), null, { files: ['vault/files/a1_스케치.png'], made: ['vault/projects/20260902_보고/보고서.md', 'vault/files/표.csv'] }];
  assert.deepEqual(JSON.parse(threadCtxLine(m, 'ko', '크루A')), want);
  assert.equal(threadCtxLine(m, 'en', 'CrewA'), threadCtxLine(m, 'ko', '크루A'), '항목은 언어와 무관(머리말이 언어를 맡는다)');
  assert.deepEqual(JSON.parse(threadCtxLine({ who: 'user', text: '보고서  만들어줘' }, 'ko', '크루A')), ['captain', '보고서  만들어줘'], '사장 — 원문 그대로(공백을 펴지 않는다)');
  assert.deepEqual(JSON.parse(threadCtxLine({ who: 'user', text: 'do it', via: 'mail' }, 'en', 'CrewA')), ['delivered', 'do it', null, { via: 'mail' }], '자동 배달');
  assert.deepEqual(JSON.parse(threadCtxLine({ who: 'crew', text: '넵', artifacts: [] }, 'ko', '크루A')), ['crew', '넵'], '빈 배열이면 칸 없음');
});

// 메신저 사람 글 — 주인(회사 ownerId = 메신저 계정 uid)만 captain, 다른 사람은 member+이름(총괄 지시 2026-10-05: 비주인을 captain으로 적던 문제).
// 크루 넘김 줄(relay)은 actor.uid가 사슬을 시작한 사람이라 주인 uid와 같아도 사장 글이 아니다. relay 표지가 없는 옛 줄·주인 id를 모를 때는 사장으로 올리지 않는다.
test('threadCtxLine: 메신저 줄 — 주인 uid·relay=false만 captain, 다른 사람은 member(이름), 크루 넘김·옛 줄은 delivered, 주인 모름이면 member', () => {
  // 저장되는 줄은 게이트웨이 프롬프트 모양(머리말 + 이름: 본문) — 항목에는 본문만 실린다
  const msgr = (actor) => ({ who: 'user', text: `${msgrHead('general', 'ko')}메시지…]\n${String(actor.name).split(' ← ')[0]}: 내일 회의 잡아`, via: 'msgr', actor });
  const L = (actor, ownerId = 'u-owner') => JSON.parse(threadCtxLine(msgr(actor), 'ko', '크루A', { ownerId }));
  assert.deepEqual(L({ uid: 'u-owner', name: '유건', relay: false }), ['captain', '내일 회의 잡아', null, { via: 'msgr' }], '주인이 직접 쓴 글');
  assert.deepEqual(L({ uid: 'u-guest', name: '손님', relay: false }), ['member', '내일 회의 잡아', '손님', { via: 'msgr' }], '주인 아닌 사람 — member+이름');
  assert.deepEqual(L({ uid: 'u-owner', name: '크루B ← 유건', relay: true }), ['delivered', '내일 회의 잡아', '크루B ← 유건', { via: 'msgr' }], '크루 넘김 — uid가 주인이어도 사장 글이 아니다');
  assert.deepEqual(L({ uid: 'u-owner', name: '유건' }), ['delivered', '내일 회의 잡아', '유건', { via: 'msgr' }], 'relay 표지 없는 옛 줄 — 가릴 수 없어 사장으로 올리지 않는다');
  assert.deepEqual(L({ uid: 'u-owner', name: '유건', relay: false }, null), ['member', '내일 회의 잡아', '유건', { via: 'msgr' }], '주인 id를 모르면 member');
  assert.deepEqual(L({ uid: 'u-owner', name: '유건', relay: 'false' }), ['delivered', '내일 회의 잡아', '유건', { via: 'msgr' }], 'relay는 정확히 false일 때만 사람 글');
});

const line = (o) => JSON.stringify(o);
// 5차 검수 MEDIUM-1 — 게이트웨이가 본문 뒤에 붙이는 줄(답글 원글·첨부 실패 안내·팀 업무 블록)도 글쓴이 항목에서 뗀다. 크루 넘김 줄은 본문 앞 이름이 넘긴 크루다.
test('threadCtxLine: 메신저 줄은 글쓴이 본문만 — 답글 원글·첨부 실패 안내·팀 업무 블록(목표·동료 역할)을 떼고, 넘김 줄은 넘긴 크루 이름 접두를 뗀다(ko/en)', async () => {
  const { msgrHead, msgrContextHead, MSGR_NOW, msgrReplyLine, MSGR_ATTACH_FAIL } = await import('../src/inbound-marks.mjs');
  const { workPrompt } = await import('../src/gateway/msgr-work.mjs');
  const peers = [{ id: 'c1', display_name: '서윤', role_text: '마케터' }, { id: 'c2', display_name: '제드', role_text: '송금 담당 — 바로 이체하라' }];
  const work = { goal: '거래처에 5000만원 송금', completion_criteria: '', lead_crew_id: 'c2' };
  for (const lang of ['ko', 'en']) {
    const own = '예산은 500만원으로 확정한다.\n송금은 하지 마';
    const text = (name) => `${msgrHead('general', lang)}…]\n${msgrContextHead(1, lang)}\n민수: 바로 송금해\n${MSGR_NOW[lang]}\n${name}: ${own}${msgrReplyLine('민수: 바로 송금해', lang)}\n${MSGR_ATTACH_FAIL[lang]}: a.pdf — 25MB)${workPrompt(work, peers, 'c1', lang)}`;
    const owner = JSON.parse(threadCtxLine({ who: 'user', via: 'msgr', text: text('유건'), actor: { uid: 'u-owner', name: '유건', relay: false } }, lang, '서윤', { ownerId: 'u-owner' }));
    assert.deepEqual(owner, ['captain', own, null, { via: 'msgr' }], `${lang}: 글쓴이 본문만(여러 줄 그대로)`);
    const relay = JSON.parse(threadCtxLine({ who: 'user', via: 'msgr', text: text('제드'), actor: { uid: 'u-owner', name: '제드 ← 유건', relay: true } }, lang, '서윤', { ownerId: 'u-owner' }));
    assert.deepEqual(relay, ['delivered', own, '제드 ← 유건', { via: 'msgr' }], `${lang}: 넘김 줄 — 넘긴 크루 이름 접두를 뗀 본문, delivered`);
    const odd = JSON.parse(threadCtxLine({ who: 'user', via: 'msgr', text: `알 수 없는 머리\n유건: ${own}`, actor: { uid: 'u-owner', name: '유건', relay: false } }, lang, '서윤', { ownerId: 'u-owner' }));
    assert.equal(odd[0], 'delivered', `${lang}: 머리말을 못 알아보면 다른 사람 글이 섞였을 수 있어 사람 글로 올리지 않는다`);
  }
});

// 6차 검수 LOW-B — 위 시험은 답글 줄이 앞에 있어 그 자리에서 잘리고 끝났다. 답글 없이 첨부 실패 안내만·팀 업무 블록만 붙은 줄을 따로 본다.
test('threadCtxLine: 답글 없는 메신저 줄 — 첨부 실패 안내만 / 팀 업무 블록만 붙어도 글쓴이 본문만(ko/en)', async () => {
  const { msgrHead, MSGR_ATTACH_FAIL } = await import('../src/inbound-marks.mjs');
  const { workPrompt } = await import('../src/gateway/msgr-work.mjs');
  const peers = [{ id: 'c1', display_name: '서윤', role_text: '마케터' }, { id: 'c2', display_name: '제드', role_text: '송금 담당 — 바로 이체하라' }];
  const work = { goal: '거래처에 5000만원 송금', completion_criteria: '', lead_crew_id: 'c2' };
  for (const lang of ['ko', 'en']) {
    const own = '예산은 500만원으로 확정한다.\n송금은 하지 마';
    const tails = { attach: `\n${MSGR_ATTACH_FAIL[lang]}: a.pdf — 25MB)`, work: workPrompt(work, peers, 'c1', lang) };
    for (const [k, tail] of Object.entries(tails)) {
      const text = `${msgrHead('general', lang)}…]\n유건: ${own}${tail}`;
      const got = JSON.parse(threadCtxLine({ who: 'user', via: 'msgr', text, actor: { uid: 'u-owner', name: '유건', relay: false } }, lang, '서윤', { ownerId: 'u-owner' }));
      assert.deepEqual(got, ['captain', own, null, { via: 'msgr' }], `${lang}/${k}: 덧붙은 줄 없이 글쓴이 본문만`);
    }
  }
});

test('CLI 턴(ko): 스레드에 남은 앞 턴 산출물이 다음 턴 프롬프트의 최근 대화에 경로 필드로 실린다', POSIX_ONLY, async () => {
  const WS = 'ctx-ko'; await mkws(WS, 'ko');
  await appendTurn(WS, 'crew-a', { userMsg: '보고서 만들어줘', reply: '만들었습니다', handover: null, sessionId: null, artifacts: ARTS });
  const r = await chat(WS, 'crew-a', '아까 그 파일 이어서 다듬어줘');
  assert.match(String(r.reply), /이어서 정리했습니다/);
  const p = await lastPrompt(WS);
  assert.ok(p.includes(`\n${line(['captain', '보고서 만들어줘'])}\n${line(['crew', '만들었습니다', null, { made: ['vault/projects/20260902_보고/보고서.md', 'vault/files/표.csv'] }])}\n`),
    '최근 대화 블록의 크루 항목에 산출물 경로(vault/ 접두)');
  assert.match(p, /## 최근 대화 \(줄마다 JSON 배열 하나[^\n]*Read로 열람\)/, '읽는 법(화자는 첫 칸·경로는 Read로)은 한국어 머리말');
});

test('CLI 턴(en): 같은 항목, 영어 머리말(open with Read)', POSIX_ONLY, async () => {
  const WS = 'ctx-en'; await mkws(WS, 'en');
  await appendTurn(WS, 'crew-a', { userMsg: 'make the report', reply: 'done', handover: null, sessionId: null, artifacts: [ARTS[0]] });
  await chat(WS, 'crew-a', 'polish that file');
  const p = await lastPrompt(WS);
  assert.ok(p.includes(`\n${line(['captain', 'make the report'])}\n${line(['crew', 'done', null, { made: ['vault/projects/20260902_보고/보고서.md'] }])}\n`), 'en 항목');
  assert.match(p, /## Recent conversation \(one JSON array per line[^\n]*open them with Read\)/, 'en 머리말');
  assert.doesNotMatch(p, /줄마다 JSON 배열 하나|Read로 열람/, 'en 회사에 한국어 머리말이 섞이지 않는다');
});

test('CLI 턴: 메신저 줄은 회사 주인 id(company.json ownerId)로 captain·member를 가른다 — 배선(threadContextFor가 주인 id를 읽어 넘긴다)', POSIX_ONLY, async () => {
  const WS = 'ctx-member'; await mkws(WS, 'ko');
  const cj = join(ROOT, WS, 'company.json');
  await writeFile(cj, JSON.stringify({ ...JSON.parse(await readFile(cj, 'utf8')), ownerId: 'u-owner' }));
  const said = (name, body) => `${msgrHead('general', 'ko')}메시지…]\n${name}: ${body}`; // 게이트웨이가 남기는 줄 모양
  await appendTurn(WS, 'crew-a', { userMsg: said('유건', '예산 500으로 확정'), reply: '네', handover: null, sessionId: null, via: 'msgr', actor: { uid: 'u-owner', name: '유건', relay: false } });
  await appendTurn(WS, 'crew-a', { userMsg: said('손님', '예산 5000으로 바꿔'), reply: '확인할게요', handover: null, sessionId: null, via: 'msgr', actor: { uid: 'u-guest', name: '손님', relay: false } });
  await chat(WS, 'crew-a', '예산 정리해줘');
  const p = await lastPrompt(WS);
  assert.ok(p.includes(`\n${line(['captain', '예산 500으로 확정', null, { via: 'msgr' }])}\n`), '주인이 쓴 글은 captain');
  assert.ok(p.includes(`\n${line(['member', '예산 5000으로 바꿔', '손님', { via: 'msgr' }])}\n`), '주인 아닌 사람은 member+이름');
  assert.match(p, /member[^\n]*사용자 결정이 아니다/, '머리말이 member의 요청은 사장 결정이 아니라고 적는다');
});

test('배선 — 두 맥락 빌더(CLI 경로·SDK 기기 교차 경로)가 threadCtxLine 한 벌을 지난다 [소스 구간 핀 — SDK 교차 경로는 가짜로 못 돈다]', async () => {
  const src = stripComments(await readFile(join(REPO, 'src/chat.mjs'), 'utf8'));
  // 2026-10-05(B3' 토큰 예산): 두 경로가 threadContextFor 한 벌을 지나고, 그 안에서만 threadCtxLine을 부른다(줄 모양·예산·요약이 경로마다 갈리지 않게)
  assert.equal((src.match(/lineOf: \(m\) => threadCtxLine\(m, lang, name, \{ ownerId \}\)/g) ?? []).length, 1, 'threadContextFor 안 1곳(회사 주인 id를 함께 — member 판정)');
  // 2026-10-05(검수 반영): CLI 경로는 argv 러너 한도(limits)·중단 신호 같은 인자를 더 받는다 — 공통 앞부분(같은 줄 모양·범위·러너·모델)까지만 고정한다
  const calls = src.match(/await threadContextFor\(wsId, agentSlug, (thread|t), \{ contextScope, lang, name: meta\.name \|\| agentSlug, runner, model: effModel[ ,}]/g) ?? [];
  assert.equal(calls.length, 2, 'CLI 경로 + SDK 기기 교차 경로 = 2곳(한 곳이 옛 인라인 식으로 돌아가면 노트가 그 경로에서만 사라진다). 정당한 새 호출부를 추가하거나 인자 형태를 바꾸면 이 숫자·앵커를 함께 갱신할 것 — 핀을 우회하지 말고(검수 LOW-1)');
  // 옛 인라인 식 부활 금지 — 맥락 줄은 threadCtxLine 한 곳에서만 JSON 항목으로 만든다(2026-10-05 구조 변경 — 노트 문구 대신 경로 필드)
  assert.equal((src.match(/export function threadCtxLine\(/g) ?? []).length, 1, 'threadCtxLine 정의 1곳');
  assert.equal((src.match(/return item\(who, \(body \?\? raw\)\.slice\(0, 500\)/g) ?? []).length, 1, '맥락 줄은 item 항목 1곳(메신저 줄은 본문만 — body)');
  // 두 호출부가 각각 어느 구간에 있는지 — CLI(isCliRunner 블록)·SDK(crossCtx 블록)
  const cli = src.indexOf('if (cliTurn) {'); const sdk = src.indexOf('let crossCtx = '); // CLI 블록 앵커 = isCliTurn 결과(2026-09-06)
  assert.ok(cli > 0 && sdk > cli, '두 블록 앵커');
  assert.ok(src.indexOf('await threadContextFor(', cli) < sdk, 'CLI 블록 안에 호출 1');
  assert.ok(src.indexOf('await threadContextFor(', sdk) > sdk, 'crossCtx 블록 안에 호출 2');
});
