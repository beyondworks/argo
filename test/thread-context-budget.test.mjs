// 스레드 맥락 토큰 예산(B3') — CLI 러너(codex exec·gemini -p·agy)와 Claude SDK 다른 기기 이어받기는 종전에 최근 6개 메시지만 글로 붙였다.
// 이제 최근 대화를 예산(24,000토큰, utf-8 바이트/3) 안에서 최대한 넣고, 예산 밖 오래된 부분은 스레드에 저장한 누적 요약 {text, upto}로 넣는다.
// 요약은 예산 밖에 새로 쌓인 메시지가 20개 이상일 때만 1회 갱신한다(턴마다 요약 호출 금지). 실패하면 요약 없이 최근 대화만.
// 잠그는 것: ① 순수 계획·갱신 주기·실패·앵커 무효 ② 실제 CLI 턴(가짜 codex)의 프롬프트에 6개 넘는 대화와 요약이 실리고 요약은 스레드에 남는다
// ③ 연속 턴에 요약을 다시 부르지 않는다 ④ 범위 요약은 채널 기억 회수 때 같이 지워진다.
// ⚠ workspace.mjs의 WS_ROOT는 모듈 로드 시점에 고정 — env를 어떤 임포트보다 먼저 잡는다(실데이터 미접촉).
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-ctx-budget-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_MODEL_CATALOG = 'off';
const mkws = async (ws, lang = 'ko') => {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) await mkdir(join(ROOT, ws, ...d), { recursive: true });
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang, created: new Date().toISOString() }));
  await writeFile(join(ROOT, ws, 'agents', 'crew-a.md'), '---\nname: 크루A\nrunner: codex\n---\n\n전문가.\n');
  await writeFile(join(ROOT, ws, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
};
// 가짜 codex — 받은 프롬프트를 .fake-prompts에 누적. 요약 원샷(<conversation> 태그)이면 '요약본-XYZ'를, 그 밖은 고정 답을 낸다.
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"; last="$a"
done
[ "$last" = "-" ] && last="$(cat)"
printf '%s\\n=====\\n' "$last" >> "$PWD/.fake-prompts"
case "$last" in *"<conversation>"*) ANS="요약본-XYZ 보고서 마감은 금요일" ;; *) ANS="이어서 정리했습니다." ;; esac
[ -n "$OUT" ] && printf '%s' "$ANS" > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { buildThreadContext, CTX_BUDGET_TOKENS, SUMMARY_REFRESH_MIN } = await import('../src/thread-context.mjs');
const { chat } = await import('../src/chat.mjs');
const { loadThread, threadSummary } = await import('../src/thread.mjs');
const { forgetChannels, applyDeparted } = await import('../src/departed.mjs');

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 셸 하네스 — 배선 검증은 macOS CI가 담당' : false };
const prompts = async (ws) => (await readFile(join(ROOT, ws, '.fake-prompts'), 'utf8').catch(() => '')).split('\n=====\n').filter(Boolean);
const T0 = 1_700_000_000_000;
/** 메시지 n개(사장·크루 번갈아), 각 본문 len자 */
const msgs = (n, len = 20, from = 0) => Array.from({ length: n }, (_, k) => { const i = from + k; return { who: i % 2 ? 'crew' : 'user', text: `m${i}| ${'가'.repeat(len)}`, ts: T0 + i * 1000 }; });
const lineOf = (m) => `${m.who === 'user' ? '사장' : '크루A'}: ${m.text}`;

test('TB1. 예산 안이면 6개를 넘어 전부 싣고 요약을 부르지 않는다', async () => {
  let called = 0;
  const r = await buildThreadContext({ msgs: msgs(30), lineOf, summary: null, summarize: async () => { called++; return 'x'; }, save: async () => {} });
  assert.equal(called, 0);
  assert.equal(r.summary, null);
  assert.equal(r.recent.split('\n').length, 30, '30개 전부(종전 6개)');
  assert.match(r.recent, /^사장: m0\|/); assert.match(r.recent, /m29\|/);
});

test('TB2. 예산 밖이 20개 이상이면 요약 1회 → upto는 예산 밖 마지막 메시지 ts, 다음 호출은 새로 20개 쌓일 때까지 재사용', async () => {
  const all = msgs(300, 400); // 줄당 ≈ 400토큰 → 예산 안 ≈ 60개
  let calls = []; let saved = null;
  const summarize = async (p) => { calls.push(p); return `요약${calls.length}`; };
  const save = async (s) => { saved = s; };
  const r1 = await buildThreadContext({ msgs: all, lineOf, summary: null, summarize, save });
  assert.equal(calls.length, 1, '요약 1회');
  const nRecent = r1.recent.split('\n').length;
  assert.ok(nRecent > 6 && nRecent < 300, `예산 안 최근 ${nRecent}개`);
  assert.ok(Buffer.byteLength(r1.recent, 'utf8') / 3 <= CTX_BUDGET_TOKENS, '예산 이하');
  assert.equal(r1.summary, '요약1');
  const oldest = 300 - nRecent;
  assert.equal(saved.upto, all[oldest - 1].ts, 'upto = 예산 밖 마지막 메시지');
  assert.equal(saved.text, '요약1');
  assert.match(calls[0], new RegExp(`m${oldest - 1}\\|`), '예산 밖 최신 줄이 요약 입력에');
  assert.doesNotMatch(calls[0], new RegExp(`m${oldest}\\|`), '예산 안 줄은 요약 입력에 없다');
  // 새 메시지 10개 — 예산 밖 새 몫 10 < 20 → 재사용
  const r2 = await buildThreadContext({ msgs: [...all, ...msgs(10, 400, 300)], lineOf, summary: saved, summarize, save });
  assert.equal(calls.length, 1, '요약 재호출 없음');
  assert.equal(r2.summary, '요약1', '저장한 요약을 싣는다');
  // 새 메시지 30개(누적 40) — 새 몫 ≥ 20 → 1회 갱신, 이전 요약이 입력에 들어간다
  const r3 = await buildThreadContext({ msgs: [...all, ...msgs(40, 400, 300)], lineOf, summary: saved, summarize, save });
  assert.equal(calls.length, 2, '20개 이상 쌓이면 갱신');
  assert.match(calls[1], /요약1/, '누적 요약 — 이전 요약을 합친다');
  assert.equal(r3.summary, '요약2');
  assert.ok(SUMMARY_REFRESH_MIN === 20);
});

test('TB3. 요약 실패 → 요약 없이 예산 안 최근 대화만, 저장하지 않는다 / 앵커 메시지가 없어진 요약은 쓰지 않는다', async () => {
  const all = msgs(300, 400);
  let saved = null;
  const r = await buildThreadContext({ msgs: all, lineOf, summary: null, summarize: async () => { throw new Error('runner down'); }, save: async (s) => { saved = s; } });
  assert.equal(r.summary, null); assert.equal(saved, null);
  assert.ok(r.recent.split('\n').length > 6);
  // 새 대화(리셋)·회수로 앵커가 사라졌다 — 옛 요약을 싣지 않는다(예산 밖이 20개 미만이라 새로 부르지도 않는다)
  const few = msgs(70, 400, 1000);
  const r2 = await buildThreadContext({ msgs: few, lineOf, summary: { text: '옛 대화 요약', upto: T0 + 5 * 1000 }, summarize: async () => 'new', save: async () => {} });
  assert.equal(r2.summary, null, '앵커 없는 요약은 무효');
});

test('TB4. CLI 턴(가짜 codex): 6개 넘는 대화가 프롬프트에 실린다(요약 호출 없음)', POSIX_ONLY, async () => {
  const WS = 'tb4'; await mkws(WS);
  await writeFile(join(ROOT, WS, 'chats', 'crew-a.json'), JSON.stringify({ sessionId: null, messages: msgs(30) }));
  await chat(WS, 'crew-a', '이어서 해줘');
  const ps = await prompts(WS);
  assert.equal(ps.length, 1, '요약 원샷 없이 턴 1번');
  for (const i of [0, 7, 29]) assert.match(ps[0], new RegExp(`m${i}\\|`), `m${i} 줄이 최근 대화에`);
});

test('TB5. CLI 턴(가짜 codex): 긴 스레드는 요약 1회(같은 러너) → 프롬프트에 요약+최근 대화, 스레드에 {text, upto} 저장, 다음 턴은 재호출 없음', POSIX_ONLY, async () => {
  const WS = 'tb5'; await mkws(WS);
  await writeFile(join(ROOT, WS, 'chats', 'crew-a.json'), JSON.stringify({ sessionId: null, messages: msgs(300, 400) }));
  await chat(WS, 'crew-a', '보고서 이어서');
  let ps = await prompts(WS);
  assert.equal(ps.length, 2, '요약 원샷 1번 + 턴 1번');
  assert.match(ps[0], /<conversation>/, '첫 호출은 요약(같은 codex 러너)');
  assert.match(ps[1], /요약본-XYZ 보고서 마감은 금요일/, '턴 프롬프트에 요약');
  assert.match(ps[1], /m299\|/, '최근 대화도');
  const t = await loadThread(WS, 'crew-a');
  const s = threadSummary(t, null);
  assert.equal(s?.text, '요약본-XYZ 보고서 마감은 금요일');
  assert.ok(t.messages.some((m) => m.ts === s.upto), 'upto는 실제 메시지 ts');
  await chat(WS, 'crew-a', '하나 더');
  ps = await prompts(WS);
  assert.equal(ps.length, 3, '다음 턴은 요약 재호출 없이 턴만');
  assert.match(ps[2], /요약본-XYZ/, '저장한 요약을 다시 싣는다');
});

test('TB6. 채널 기억 회수 — 그 채널 범위 요약도 같이 지운다(다시 들어온 뒤의 새 요약은 남는다)', () => {
  const CH = '11111111-2222-4333-8444-555555555555';
  const scope = { kind: 'msgr', channelId: CH };
  const t = { messages: [{ who: 'user', text: 'a', ts: 10, contextScope: scope }, { who: 'crew', text: 'b', ts: 20, contextScope: scope }], scopedSummaries: { [CH]: { text: '채널 요약', upto: 10 } } };
  assert.equal(threadSummary(t, scope)?.text, '채널 요약');
  forgetChannels(t, [CH]);
  assert.equal(threadSummary(t, scope), null, '회수한 채널의 요약은 남지 않는다');
  t.messages.push({ who: 'user', text: 'c', ts: 30, contextScope: scope }); t.scopedSummaries = { [CH]: { text: '재입장 뒤 요약', upto: 30 } };
  applyDeparted(t); // 읽을 때·동기화 병합 때 다시 적용되는 각인 — 재입장 뒤 요약(upto > 각인 ts)은 지우지 않는다
  assert.equal(threadSummary(t, scope)?.text, '재입장 뒤 요약');
});
test('TB7. 요약 안내 줄(chat.mjs compact_boundary — src notice code summarized)은 다음 턴의 스레드 맥락에 싣지 않는다(다른 세션 안내 줄은 종전대로)', POSIX_ONLY, async () => {
  const WS = 'tb7'; await mkws(WS);
  const notice = { who: 'crew', text: '앞 대화를 요약해 이어 갑니다', ts: T0 + 50_000, src: { kind: 'session', dir: 'notice', code: 'summarized' } };
  const capNote = { who: 'crew', text: '상한 안내 원문', ts: T0 + 60_000, src: { kind: 'session', dir: 'notice', code: 'cap', cap: 3 } };
  await writeFile(join(ROOT, WS, 'chats', 'crew-a.json'), JSON.stringify({ sessionId: null, messages: [...msgs(4), notice, capNote] }));
  await chat(WS, 'crew-a', '이어서');
  const ps = await prompts(WS);
  assert.equal(ps.length, 1);
  assert.match(ps[0], /m3\|/, '대화 줄은 싣는다');
  assert.doesNotMatch(ps[0], /앞 대화를 요약해 이어 갑니다/, '요약 안내 줄은 맥락이 아니다');
  assert.match(ps[0], /상한 안내 원문/, '세션 상한 같은 다른 안내 줄은 종전대로 싣는다');
});

