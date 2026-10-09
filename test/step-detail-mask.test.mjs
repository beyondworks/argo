// 턴 진행 단계 요약(detailForTool)은 **가린 뒤에 자른다** — 0.1.99 이하는 가리지 않은 원문을 48자(Bash 명령)·120자(설명)·48자(검색어)로 잘라
// 상태 파일과 활동 이벤트(events.jsonl — 기기 간 동기화·클라우드 저장소)의 turn 이벤트 steps에 그대로 실었다.
// 명령 앞 48자에 든 Authorization 헤더·sk-/ghp_ 키·URL 비밀번호·-p비밀번호·--token X가 원문으로 남는다. 토큰이 48자 경계에 걸리면 앞 몇 글자만 남는다.
// 가짜 값만 쓴다(FAKE 반복 — 실제 키 모양 접두사 + 명백한 가짜 본문).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-stepmask-'));
const { detailForTool } = await import('../src/turn-status.mjs');

const oldCut = (cmd) => String(cmd).replace(/\s+/g, ' ').slice(0, 48); // 고치기 전 동작 — 이 모양대로 잘라 비밀이 앞 48자에 들어오는 사례만 쓴다
const bash = (command, opts) => detailForTool('Bash', { command }, opts);

const F = 'FAKE0000'; // 명백한 가짜 본문 조각
const XOX = 'xo' + 'x'; // Slack 토큰 접두사는 이어 붙여 만든다 — 소스에 한 줄로 두면 GitHub 푸시 보호가 진짜 토큰으로 막는다
const TOK32 = F.repeat(4);
const TOK40 = F.repeat(5);

// [이름, 명령, 가려져야 하는 조각] — 조각은 옛 동작(앞 48자)에서 실제로 새던 것이어야 한다(아래에서 사전 확인)
const LEAKS = [
  ['Authorization Bearer(48자 경계에 걸침)', `curl -s -H "Authorization: Bearer ${TOK40}" https://x.test`, F],
  ['Authorization Basic', 'curl -H "Authorization: Basic ZmFrZTpmYWtlcGFzcw==" https://x.test', 'ZmFrZTpm'],
  ['Bearer(헤더 이름 없이)', `echo Bearer ${TOK32}`, F],
  ['sk- 키', 'echo sk-FAKEFAKEFAKEFAKEFAKE000', 'FAKEFAKEFAKE'],
  ['sk-ant- 키', 'echo sk-ant-api03-FAKEFAKEFAKEFAKE00', 'FAKEFAKEFAKE'],
  ['GitHub ghp_', `git clone https://ghp_${TOK40}@github.com/o/r.git`, F],
  ['GitHub github_pat_', `echo github_pat_${TOK40}`, F],
  ['GitLab glpat-', `echo glpat-${TOK32}`, F],
  ['Slack xoxb-', `echo ${XOX}b-1234567890-FAKEFAKEFAKEFAKE`, 'FAKEFAKE'],
  ['AWS AKIA', 'echo AKIAFAKEFAKEFAKEFAKE', 'FAKEFAKE'],
  ['npm_', `echo npm_${TOK40}`, F],
  ['Hugging Face hf_', `echo hf_${TOK40}`, F],
  ['URL 비밀번호', 'psql postgresql://admin:S3cretFAKEpw@db.example.test:5432/app', 'S3cretFAKEpw'],
  ['URL 비밀번호에 @', 'psql postgresql://admin:p@FAKEpw0000@db.example.test/app', 'FAKEpw0000'],
  ['mysql -p붙여쓰기', 'mysql -u root -pFAKEpass12345 mydb', 'FAKEpass12345'],
  ['mysqldump -p따옴표', "mysqldump -u root -p'FAKE pass 12345' mydb", 'FAKE'],
  ['sshpass -p', 'sshpass -p FAKEpass12345 ssh host', 'FAKEpass12345'],
  ['--password 값', 'mytool --password FAKEpass12345 run', 'FAKEpass12345'],
  ['--password=값', 'mytool --password=FAKEpass12345 run', 'FAKEpass12345'],
  ['--token 값', `mytool --token ${TOK32} run`, F],
  ['--api-key 값', `mytool --api-key ${TOK32} run`, F],
  ['--api-key="값"', `mytool --api-key="${TOK32}" run`, F],
  ['curl -u user:pass', 'curl -u admin:FAKEpass12345 https://x.test', 'FAKEpass12345'],
  ['curl --user=user:pass', 'curl --user=admin:FAKEpass12345 https://x.test', 'FAKEpass12345'],
  ['이름이 비밀인 KEY=값', `OPENAI_API_KEY=${TOK32} node run.js`, F],
  ['PGPASSWORD=값', 'PGPASSWORD=FAKEpass12345 psql -h db', 'FAKEpass12345'],
  ['DB_PASSWORD="값"', 'DB_PASSWORD="FAKEpass12345" node a.js', 'FAKEpass12345'],
  ['Cookie 헤더', `curl -H "Cookie: sid=${TOK32}" https://x.test`, F],
];

test('사전 확인: 표의 모든 사례는 옛 동작(앞 48자 그대로)에서 실제로 비밀 조각이 샜다 — 표가 헛돌지 않는다', () => {
  for (const [name, cmd, piece] of LEAKS) assert.ok(oldCut(cmd).includes(piece), `${name}: 조각 ${piece}가 앞 48자 안에 없다 — 사례를 고쳐라: ${oldCut(cmd)}`);
});

for (const [name, cmd, piece] of LEAKS) {
  test(`Bash 요약: ${name} — 비밀 조각이 남지 않고 48자를 넘지 않는다`, () => {
    const out = bash(cmd);
    assert.ok(!out.includes(piece), `비밀 조각 ${piece}가 요약에 남았다: ${out}`);
    assert.ok(out.length <= 48, `48자를 넘었다(${out.length}): ${out}`);
    assert.match(out, /\*/, `가린 표시가 앞 48자에 보여야 한다: ${out}`);
  });
}

test('48자 경계: 토큰이 47번째 글자에서 시작해도 앞 몇 글자가 남지 않는다', () => {
  const lead = 'curl -s -H "Authorization: Bearer'; // 35자 + 공백 → 토큰이 36번째에서 시작
  for (let pad = 0; pad <= 14; pad += 1) {
    const cmd = `${'x'.repeat(pad)} ${lead} ${TOK40}"`;
    const out = bash(cmd);
    assert.ok(!/FAKE|0000/.test(out), `pad=${pad}: 토큰 앞 글자가 남았다: ${out}`);
    assert.ok(out.length <= 48);
  }
  // 토큰이 정확히 48번째 글자 근처에서 시작하는 경우(--token 값)
  for (let pad = 30; pad <= 46; pad += 1) {
    const out = bash(`${'a'.repeat(pad)} --token ${TOK40} tail`);
    assert.ok(!/FAKE|0000/.test(out), `pad=${pad}: 토큰 앞 글자가 남았다: ${out}`);
  }
});

test('설명(display) 120자 — description에 든 비밀도 가린다', () => {
  const description = `Call the API with Authorization: Bearer ${TOK40} and print the body`;
  const out = detailForTool('Bash', { command: 'curl x', description }, { display: true });
  assert.ok(!out.includes(F), `설명에 토큰이 남았다: ${out}`);
  assert.match(out, /Bearer \*\*\*/);
  assert.ok(out.length <= 120);
});

test('WebSearch 검색어·Grep 패턴·Glob 패턴·파일 이름에 든 비밀도 가린다', () => {
  assert.ok(!detailForTool('WebSearch', { query: `why does ghp_${TOK40} fail` }).includes(F));
  assert.ok(!detailForTool('Grep', { pattern: `ghp_${TOK40}` }).includes(F));
  assert.ok(!detailForTool('Glob', { pattern: `**/*${'sk-FAKEFAKEFAKEFAKEFAKE0000'}*` }).includes('FAKEFAKEFAKE'));
  assert.ok(!detailForTool('Read', { file_path: `/tmp/ghp_${TOK40}` }).includes(F));
});

test('WebFetch는 호스트 이름만 — URL의 사용자:비밀번호·경로는 처음부터 실리지 않는다', () => {
  assert.equal(detailForTool('WebFetch', { url: 'https://user:FAKEpass12345@api.example.test/v1/x?token=FAKE0000FAKE0000' }), 'api.example.test');
});

test('평범한 명령은 그대로다(공백만 한 칸으로, 48자) — 옛 동작과 글자까지 같다', () => {
  const ORDINARY = [
    'mkdir -p /tmp/a/b && ls -la', 'mkdir -pv /tmp/x/y/z', 'cp -pr src dst', 'git status --short', 'git log --oneline -n 5',
    'npm test -- --grep "foo"', 'node --test test/chat.test.mjs', 'ssh -p 22 host.example.test', 'docker run -u 1000:1000 img',
    'grep -rn "password" src/', 'echo "Basic setup is done"', 'git commit -m "fix: password reset flow"', 'sort -b file.txt | uniq -c',
    'tar -xzf a.tgz -C /tmp', 'curl -sS https://example.test/api/health', 'npm run build --if-present', 'ls  \n  -la   /tmp',
    'find . -name "*.mjs" -not -path "./node_modules/*"', 'echo token refreshed', 'export NODE_ENV=production', 'KEYBOARD=us node a.js',
    'git config user.name', 'cat package.json | head -20', 'python3 -c "print(1)"', 'pwd', '',
  ];
  for (const c of ORDINARY) assert.equal(bash(c), oldCut(c), `평범한 명령이 바뀌었다: ${JSON.stringify(c)} → ${JSON.stringify(bash(c))}`);
});

test('비문자열·빈 입력에도 던지지 않는다(디테일은 장식)', () => {
  assert.equal(detailForTool('Bash', {}), '');
  assert.equal(detailForTool('Bash', { command: null }), '');
  assert.equal(detailForTool('Bash', { command: 12345 }), '12345');
  assert.equal(detailForTool('WebSearch', {}), '');
  assert.equal(detailForTool('Grep', {}), '');
  assert.equal(detailForTool('mcp__crew__delegate', { to: 'alice' }), 'alice');
  assert.equal(detailForTool('mcp__foo__bar', {}), 'foo · bar');
});
