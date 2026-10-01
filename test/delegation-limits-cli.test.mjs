// 위임 제한 스위치 — 가짜 codex CLI로 **CLI 크루 다리 턴**의 프롬프트·지시 블록 연결을 행동으로 잠근다(검수 2026-10-01 MEDIUM-2·3).
// 가짜 codex는 받은 프롬프트를 기록하고, 모드 파일이 있으면 답변에 쪽지 지시 블록 N개를 적는다(실제 모델이 한 답에 여러 블록을 내는 경우의 재현).
import { mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-deleg-cli-'));
process.env.ARGO_ROOT = ROOT;
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
const BIN = join(ROOT, 'bin');
const CAP = join(ROOT, 'captured.txt');
const BLOCKS = join(ROOT, 'blocks-n');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; P=""; after=0
for a in "$@"; do
  if [ "$after" = "1" ]; then P="$a"; after=0; fi
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  if [ "$a" = "--" ]; then after=1; fi
  prev="$a"
done
[ "$P" = "-" ] && P="$(cat)"
{ printf '===PROMPT===\\n%s' "$P"; } > "${CAP}"
if [ -f "${BLOCKS}" ]; then
  N=$(cat "${BLOCKS}"); i=0; : > "$OUT"
  while [ "$i" -lt "$N" ]; do
    printf '\`\`\`argo\\n{"action":"mail","to":"bee","message":"블록 %s"}\\n\`\`\`\\n' "$i" >> "$OUT"
    i=$((i+1))
  done
  exit 0
fi
[ -n "$OUT" ] && printf '알겠습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { newTree } = await import('../src/delegation-limits.mjs');
const { listMail } = await import('../src/crewmail.mjs');

const WS = 'deleg-cli';
await createCompany(WS, '위임 CLI', 'captain', null, 'ko');
await mkdir(paths(WS).agents, { recursive: true });
await writeFile(join(paths(WS).agents, 'ay.md'), '---\nname: 에이\nrole: 기획\nrunner: codex\n---\n기획한다.\n');
await writeFile(join(paths(WS).agents, 'bee.md'), '---\nname: 비\nrole: 검증\nrunner: codex\n---\n검증한다.\n');
await saveRunnerCred(WS, 'codex', 'apikey', 'sk-test-fake');
const prompt = async () => (await readFile(CAP, 'utf8')).split('===PROMPT===')[1];
const opts = { skip: process.platform === 'win32' };
const ROSTER_ON = /위임은 턴당 최대 2회/; const ROSTER_OFF = /위임은 턴당 최대 10회\(쪽지는 최대 10회\)/;

test('codex 크루 다리 턴 — 풀림은 동료 안내에 상한 숫자가, 켜짐은 종전 문구가 실린다', opts, async () => {
  await chat(WS, 'ay', '비에게 검증을 맡겨라', null, { delegationRelaxed: true });
  const relaxed = await prompt();
  assert.match(relaxed, ROSTER_OFF); assert.doesNotMatch(relaxed, ROSTER_ON);
  await chat(WS, 'ay', '비에게 검증을 맡겨라', null, {});
  const on = await prompt();
  assert.match(on, ROSTER_ON); assert.doesNotMatch(on, /최대 10회/);
});

test('codex 크루 다리 턴 — 풀림은 hop 3에서도 동료 안내가 있고(켜짐은 없음), hop 4는 위임 단계의 끝 안내', opts, async () => {
  const chain = ['a', 'b', 'ay'];
  await chat(WS, 'bee', '이어서', null, { from: 'ay', hop: 3, chain, delegationRelaxed: true, delegationTree: newTree({ kind: 'chat', slug: 'ay' }) });
  assert.match(await prompt(), ROSTER_OFF);
  await chat(WS, 'bee', '이어서', null, { from: 'ay', hop: 3, chain });
  assert.doesNotMatch(await prompt(), /동료 크루 — 위임 규칙/);
  await chat(WS, 'bee', '이어서', null, { from: 'ay', hop: 4, chain: [...chain, 'x'], delegationRelaxed: true, delegationTree: newTree({ kind: 'chat', slug: 'ay' }) });
  const last = await prompt();
  assert.match(last, /허용된 위임 단계\(4단계\)의 끝/); assert.doesNotMatch(last, /동료 크루 — 위임 규칙/);
});

test('codex 턴이 답변에 쪽지 지시 블록을 25개 적어도 — 켜짐 2건, 풀림 10건만 나간다(합계 예산도 차감)', opts, async () => {
  await writeFile(BLOCKS, '25');
  try {
    const before = (await listMail(WS)).pending.length;
    await chat(WS, 'ay', '비에게 다 보내라', null, {});
    const mid = (await listMail(WS)).pending.length;
    assert.equal(mid - before, 2, '켜짐 — 블록 25개여도 쪽지 2건');
    await chat(WS, 'ay', '비에게 다 보내라', null, { delegationRelaxed: true });
    const after = (await listMail(WS)).pending;
    assert.equal(after.length - mid, 10, '풀림 — 쪽지 10건');
    const relaxedMails = await Promise.all(after.slice(mid).map(async (m) => JSON.parse(await readFile(join(paths(WS).root, 'mail', m.to, `${m.id}-${m.kind}.json`), 'utf8'))));
    const withTree = relaxedMails.filter((m) => m.relaxed === true && m.tree);
    assert.ok(withTree.length >= 10, '풀린 쪽지는 relaxed + 합계 예산 id를 달고 나간다');
  } finally { await rm(BLOCKS, { force: true }); }
});
