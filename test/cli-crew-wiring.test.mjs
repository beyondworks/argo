// K94 배선 — 실제 chat() codex 턴이 크루 다리를 config.toml [mcp_servers.crew]로 받고(도구 상한 포함), 프롬프트가 도구 판(결재 도구·동료 명단)으로
// 바뀌는지. 가짜 codex가 받은 설정 파일·프롬프트를 기록한다(진짜 codex 왕복은 스크래치 E2E로 실측 — 위임 B 턴·결재 등록).
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-cli-crew-wire-'));
process.env.ARGO_ROOT = ROOT; // workspace.mjs 임포트 전 — 실데이터 미접촉
Object.assign(process.env, { ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
const BIN = join(ROOT, 'bin');
const CAP = join(ROOT, 'captured.txt');
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
{ printf '===CONFIG===\\n'; cat "$CODEX_HOME/config.toml"; printf '\\n===PROMPT===\\n%s' "$P"; } > "${CAP}"
if [ -f "${join(ROOT, 'both-mode')}" ]; then
  # 모델 흉내: 크루 다리로 결재 도구를 부르고(실제 codex가 MCP로 하는 호출과 같은 릴레이 요청), 답변 끝에 같은 결재 지시 블록도 적는다
  URL=$(sed -n 's/^ARGO_CREW_RELAY_URL = "\\(.*\\)"$/\\1/p' "$CODEX_HOME/config.toml")
  TOK=$(sed -n 's/^ARGO_CREW_RELAY_TOKEN = "\\(.*\\)"$/\\1/p' "$CODEX_HOME/config.toml")
  curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"op":"call","name":"request_approval","arguments":{"action":"견적 메일 발송","reason":"고객 요청"}}' "$URL" > "${join(ROOT, 'tool-result.json')}"
  printf '결재를 올렸습니다.\\n\\n\`\`\`argo\\n{"action":"approval","request":"견적 메일 발송","reason":"고객 요청"}\\n\`\`\`\\n' > "$OUT"
  exit 0
fi
[ -n "$OUT" ] && printf '알겠습니다.' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1'; // 관리본(핀) 우선 반전 후에도 가짜 codex가 잡히게 — 하네스 전용 해치

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');

const WS = 'cli-wire';
await createCompany(WS, '배선사', 'captain', null, 'ko');
await mkdir(paths(WS).agents, { recursive: true });
await writeFile(join(paths(WS).agents, 'ay.md'), '---\nname: 에이\nrole: 기획\nrunner: codex\n---\n기획한다.\n');
await writeFile(join(paths(WS).agents, 'bee.md'), '---\nname: 비\nrole: 검증\nrunner: codex\n---\n검증한다.\n');
await saveRunnerCred(WS, 'codex', 'apikey', 'sk-test-fake'); // host 자격은 이 기기의 실제 codex 로그인에 기대 CI에서 미가용(9/22 CI red)

test('codex CLI 턴 — 크루 다리가 [mcp_servers.crew](30분 상한)로 실리고, 프롬프트는 결재 도구·동료 명단 판이다', { skip: process.platform === 'win32' }, async () => {
  const r = await chat(WS, 'ay', '비에게 검증을 맡겨라', null, {});
  assert.equal(r.reply.trim(), '알겠습니다.');
  const cap = await readFile(CAP, 'utf8');
  const [config, prompt] = cap.split('===PROMPT===');
  assert.match(config, /\[mcp_servers\.crew\]\ncommand = [^\n]+\nargs = \[[^\n]*crew-mcp-stdio\.mjs"\]\ntool_timeout_sec = 1800\n\[mcp_servers\.crew\.env\]\nARGO_CREW_RELAY_URL = "http:\/\/127\.0\.0\.1:\d+\/"\nARGO_CREW_RELAY_TOKEN = "[0-9a-f]{64}"/);
  assert.match(prompt, /request_approval 도구로 결재를 올리고/, '크루 도구가 있는데 지시 블록 판 결재 안내가 나갔다');
  assert.match(prompt, /- 비 \(slug: bee\)/, '동료 명단이 없으면 위임 도구를 누구에게 쓸지 모른다');
  assert.match(prompt, /이 러너에는 도구 게이트가 없어/, 'codex 셸은 게이트 밖인데 게이트가 막는다고 안내했다');
});

test('중복 실행 방지(Jev 선정 검사) — 크루가 결재 도구를 부르고 같은 결재 지시 블록도 적으면 결재는 1건만', { skip: process.platform === 'win32' }, async () => {
  const { loadApprovals } = await import('../src/approvals.mjs');
  const flag = join(ROOT, 'both-mode');
  await writeFile(flag, '1');
  try {
    const before = (await loadApprovals(WS)).length;
    const r = await chat(WS, 'ay', '견적 메일 결재를 올려라', null, {});
    const tool = JSON.parse(await readFile(join(ROOT, 'tool-result.json'), 'utf8'));
    assert.ok(!tool.isError, `결재 도구 호출이 실패했다: ${JSON.stringify(tool).slice(0, 200)}`);
    const added = (await loadApprovals(WS)).length - before;
    assert.equal(added, 1, `같은 결재가 ${added}건 쌓였다(도구 + 지시 블록 이중 실행)`);
    assert.match(r.reply, /이미 도구로 처리/, '건너뛴 지시 블록을 사용자에게 밝히지 않았다');
  } finally { await (await import('node:fs/promises')).rm(flag, { force: true }); }
});
