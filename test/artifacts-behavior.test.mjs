// 산출물 수집 — **행동** 게이트(검수 CRITICAL-3 처방: 소스 개수 단언은 buggy 조합에서만 초록인
// 안티 게이트였다. 반환 객체를 실제 실행으로 검증한다). 하네스는 분리 검수의 재현 스크립트 이식:
// 가짜 codex 바이너리를 PATH 앞에 두어 벤더 CLI 없이 CLI 분기를 실제로 돌린다. 임시 ARGO_ROOT.
import { mkdtemp, mkdir, writeFile, appendFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-art-beh-'));
process.env.ARGO_ROOT = ROOT; // workspace.mjs 임포트 전 — 실데이터 미접촉
const mkws = async (ws, company) => {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) {
    await mkdir(join(ROOT, ws, ...d), { recursive: true });
  }
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang: 'ko', created: new Date().toISOString(), ...company }));
};

// 가짜 codex — ①파일 산출(Bash 상당) ②--output-last-message에 답변 기록
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"
done
mkdir -p "$PWD/vault/projects/20260730_보고"
printf 'XLSXDATA' > "$PWD/vault/projects/20260730_보고/분기표.xlsx"
[ -n "$OUT" ] && printf '표를 vault/projects/20260730_보고/분기표.xlsx 로 만들었습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { chat } = await import('../src/chat.mjs');

test('CLI 러너 턴이 만든 파일이 반환 artifacts에 실린다(검수 CRITICAL-2 — 제보 재현의 역)', async () => {
  const WS = 'beh-cli';
  await mkws(WS, {});
  await writeFile(join(ROOT, WS, 'agents', 'crew-a.md'), '---\nname: 크루A\nrunner: codex\n---\n\n전문가.\n');
  await writeFile(join(ROOT, WS, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } } }));
  const r = await chat(WS, 'crew-a', '분기 실적표를 엑셀로 만들어줘');
  assert.match(String(r.reply), /분기표\.xlsx/);
  assert.deepEqual(r.artifacts, ['projects/20260730_보고/분기표.xlsx']);
});

test('예산 초과 턴은 안내로 정상 반환(검수 CRITICAL-1 — TDZ ReferenceError 회귀 금지)', async () => {
  const WS = 'beh-budget';
  await mkws(WS, { budgetUsd: 1 });
  await writeFile(join(ROOT, WS, 'agents', 'crew-b.md'), '---\nname: 크루B\nrunner: claude\n---\n\n전문가.\n');
  await appendFile(join(ROOT, WS, 'usage.jsonl'), `${JSON.stringify({
    ts: new Date().toISOString(), kind: 'chat', slug: 'crew-b', runner: 'claude', model: 'claude:x',
    input: 10, output: 10, cacheRead: 0, cacheCreate: 0, costUsd: 5, billed: true, ms: 100,
  })}\n`);
  const r = await chat(WS, 'crew-b', '보고서 만들어줘'); // throw 없이 안내 반환이 계약(chat.mjs 예산 분기)
  assert.match(String(r.reply), /한도|예산/);
  assert.equal(r.sessionId, null);
  assert.equal('artifacts' in r, false); // 모델을 안 부른 턴 — diff 없음(있으면 TDZ 오염의 재발 신호)
});
