// maskSecrets(src/secret-mask.mjs) — ① 패턴마다 가린다 ② 평범한 글은 그대로 ③ 두 번 돌려도 같다 ④ 공격 입력(같은 글자·반복 머리·닫히지 않는 따옴표 10만 자)에서도 정해진 시간 안에 끝난다.
// ④가 이 시험의 핵심이다: 같은 목적의 옛 규칙은 `curl `·`mysql ` 반복 4만 자에서 100ms, `a.a.a.` 4만 자에서 1.4초(이차 시간)였다 — 정규식 서비스 거부(ReDoS).
// 가짜 값만 쓴다(FAKE 반복).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, isSecretName } from '../src/secret-mask.mjs';
import { maskKeyLike } from '../src/runners/shared.mjs';
import { detailForTool } from '../src/turn-status.mjs';

const F = 'FAKE0000';
const XOX = 'xo' + 'x'; // Slack 토큰 접두사는 이어 붙여 만든다 — 소스에 한 줄로 두면 GitHub 푸시 보호가 진짜 토큰으로 막는다
const T32 = F.repeat(4);

/* ─── ① 패턴마다 ─── */
const CASES = [
  // [이름, 입력, 사라져야 하는 조각, 남아야 하는 조각(가린 자리 주변 — 무엇이 있었는지는 보인다)]
  ['PEM 개인키', `-----BEGIN RSA PRIVATE KEY-----\n${T32}\n${T32}\n-----END RSA PRIVATE KEY-----\nrest`, F, 'rest'],
  ['PEM 끝 표지 없음', `x -----BEGIN PRIVATE KEY-----\n${T32}`, F, 'x '],
  ['Bearer', `Authorization: Bearer ${T32}`, F, 'Bearer ***'],
  ['bearer 소문자', `authorization: bearer ${T32}`, F, 'bearer ***'],
  ['Authorization Basic', 'Authorization: Basic ZmFrZTpmYWtlcGFzcw==', 'ZmFrZTpm', 'Basic ***'],
  ['Authorization Token', `Authorization: Token ${T32}`, F, 'Token ***'],
  ['Authorization 스킴 없음', `Authorization: ${T32}`, F, 'Authorization: ***'],
  ['Cookie', `Cookie: sid=${T32}; other=${F}`, F, 'Cookie: ***'],
  ['Set-Cookie', `Set-Cookie: sid=${T32}`, F, 'Set-Cookie: ***'],
  ['ghp_', `ghp_${T32}${F}`, F, 'ghp_***'],
  ['gho_', `gho_${T32}`, F, 'gho_***'],
  ['github_pat_', `github_pat_${T32}_${F}`, F, 'github_pat_***'],
  ['glpat-', `glpat-${T32}`, F, 'glpat-***'],
  ['xoxb-', `${XOX}b-1234567890-FAKEFAKEFAKE`, 'FAKEFAKE', 'xoxb-***'],
  ['xoxp-', `${XOX}p-1234567890-1234567890-FAKEFAKE`, 'FAKEFAKE', 'xoxp-***'],
  ['AKIA', 'AKIAFAKEFAKEFAKEFAKE', 'FAKEFAKE', 'AKIA***'],
  ['ASIA', 'ASIAFAKEFAKEFAKEFAKE', 'FAKEFAKE', 'ASIA***'],
  ['npm_', `npm_${F.repeat(5)}`, F, 'npm_***'],
  ['hf_', `hf_${F.repeat(5)}`, F, 'hf_***'],
  ['sk- (maskKeyLike)', 'sk-FAKEFAKEFAKEFAKEFAKE000', 'FAKEFAKE', 'sk-***'],
  ['JWT (maskKeyLike)', 'eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE', 'FAKEFAKE', 'sk-***'],
  ['--password 값', 'tool --password FAKEpass12345 run', 'FAKEpass12345', '--password ***'],
  ['--password=값', 'tool --password=FAKEpass12345 run', 'FAKEpass12345', '--password=***'],
  ['--passwd 값', 'tool --passwd FAKEpass12345', 'FAKEpass12345', '--passwd ***'],
  ['--http-password 값', 'wget --http-password FAKEpass12345 u', 'FAKEpass12345', '--http-password ***'],
  ['--token 값', 'tool --token FAKEpass12345 run', 'FAKEpass12345', '--token ***'],
  ['-token 홑 하이픈', 'tool -token FAKEpass12345', 'FAKEpass12345', '-token ***'],
  ['--api-key 값', 'tool --api-key FAKEpass12345 run', 'FAKEpass12345', '--api-key ***'],
  ['--apikey=값', 'tool --apikey=FAKEpass12345', 'FAKEpass12345', '--apikey=***'],
  ['--secret "값 공백 포함"', 'tool --secret "FAKE pass 12345" run', 'FAKE pass', '--secret ***'],
  ["--client-secret '값'", "tool --client-secret 'FAKEpass12345' run", 'FAKEpass12345', '--client-secret ***'],
  ['--cookie 값', 'curl --cookie sid=FAKEpass12345 https://x.test', 'FAKEpass12345', '--cookie ***'],
  ['mysql -p붙여쓰기', 'mysql -u root -pFAKEpass12345 mydb', 'FAKEpass12345', '-p***'],
  ['mysqldump -p"값"', 'mysqldump -u root -p"FAKE pass" mydb', 'FAKE pass', '-p***'],
  ['mariadb -p', 'mariadb -h db -pFAKEpass12345', 'FAKEpass12345', '-p***'],
  ['7z -p', '7z a -pFAKEpass12345 out.7z in', 'FAKEpass12345', '-p***'],
  ['sshpass -p 값', 'sshpass -p FAKEpass12345 ssh host', 'FAKEpass12345', 'sshpass -p ***'],
  ['sshpass -p"값"', 'sshpass -p"FAKE pass" ssh host', 'FAKE pass', 'sshpass -p***'],
  ['curl -u', 'curl -u admin:FAKEpass12345 https://x.test', 'FAKEpass12345', 'admin:***'],
  ['curl -u "user:pass 공백"', 'curl -u "admin:FAKE pass" https://x.test', 'FAKE pass', 'admin:***'],
  ['curl --user=', 'curl --user=admin:FAKEpass12345 https://x.test', 'FAKEpass12345', 'admin:***'],
  ['curl -sS 뒤 -u', 'curl -sS -X POST -u admin:FAKEpass12345 https://x.test', 'FAKEpass12345', 'admin:***'],
  ['URL 비밀번호', 'postgresql://admin:S3cretFAKEpw@db.example.test:5432/app', 'S3cretFAKEpw', 'admin:***@db.example.test'],
  ['URL 비밀번호에 @', 'postgresql://admin:p@FAKEpw0000@db.example.test/app', 'FAKEpw0000', 'admin:***@db.example.test'],
  ['URL 사용자 없이 비밀번호만', 'redis://:FAKEpass12345@cache.example.test:6379', 'FAKEpass12345', ':***@cache.example.test'],
  ['URL x-access-token:ghp_', `https://x-access-token:ghp_${T32}@github.com/o/r`, F, '@github.com/o/r'],
  ['KEY=값', `OPENAI_API_KEY=${T32} node a.js`, F, 'OPENAI_API_KEY=***'],
  ['KEY="값"', 'DB_PASSWORD="FAKEpass12345" node a.js', 'FAKEpass12345', 'DB_PASSWORD="***"'],
  ["KEY='값'", "GITHUB_TOKEN='FAKEpass12345' node a.js", 'FAKEpass12345', "GITHUB_TOKEN='***'"],
  ['PGPASSWORD=값', 'PGPASSWORD=FAKEpass12345 psql -h db', 'FAKEpass12345', 'PGPASSWORD=***'],
  ['JSON "password": "값"', '{"user":"a","password":"FAKEpass12345"}', 'FAKEpass12345', '"password":"***"'],
  ['JSON "apiKey": "값"', '{"apiKey": "FAKEpass12345"}', 'FAKEpass12345', '"apiKey": "***"'],
  ['쿼리 ?token=값', 'https://x.test/p?a=1&token=FAKEpass12345&b=2', 'FAKEpass12345', 'token=***'],
  ['x-api-key 헤더', 'curl -H "x-api-key: FAKEpass12345" https://x.test', 'FAKEpass12345', 'x-api-key: ***'],
];

for (const [name, input, gone, kept] of CASES) {
  test(`가림: ${name}`, () => {
    const out = maskSecrets(input);
    assert.ok(!out.includes(gone), `비밀 조각 ${JSON.stringify(gone)}이 남았다: ${out}`);
    assert.ok(out.includes(kept), `기대한 자리 ${JSON.stringify(kept)}가 없다: ${out}`);
    assert.equal(maskSecrets(out), out, `두 번 돌리면 달라진다(멱등 아님): ${out}`);
  });
}

/* ─── ② 평범한 글은 그대로 ─── */
test('평범한 명령·글은 한 글자도 바뀌지 않는다', () => {
  const ORDINARY = [
    'mkdir -p /tmp/a/b', 'mkdir -pv /tmp/x', 'cp -pr src dst', 'ls -la /tmp', 'git status --short', 'git log --oneline -n 5', 'git config user.name',
    'npm test -- --grep "foo"', 'node --test test/chat.test.mjs', 'ssh -p 22 host.example.test', 'docker run -u 1000:1000 img', 'sort -b file.txt',
    'grep -rn "password" src/', 'echo "Basic setup is done"', 'git commit -m "fix: password reset flow"', 'curl -sS https://example.test/api/health',
    'export NODE_ENV=production', 'KEYBOARD=us node a.js', 'MONKEY=1 TURKEY=2 run', 'primaryKey=id', 'echo token refreshed', 'Bearer token is required',
    'https://example.test:8080/path?x=1', 'ssh://git@github.com:org/repo.git', 'postgresql://db.example.test:5432/app', 'npm_config_user_agent=npm/10',
    'tar -xzf a.tgz -C /tmp', 'python3 -c "print(1)"', 'mysql -u root -p mydb', 'mysql -h db --port 3306', 'unzip -P x', 'authorization is required',
    '한글 명령 실행해 줘 password 는 없다', '', '   ',
  ];
  for (const c of ORDINARY) assert.equal(maskSecrets(c), c, `평범한 글이 바뀌었다: ${JSON.stringify(c)} → ${JSON.stringify(maskSecrets(c))}`);
});

test('null·undefined·숫자도 던지지 않는다', () => {
  assert.equal(maskSecrets(null), '');
  assert.equal(maskSecrets(undefined), '');
  assert.equal(maskSecrets(42), '42');
});

test('isSecretName: 비밀 이름만 — monkey·keyboard·primaryKey·TURKEY는 아니다', () => {
  for (const n of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'client_secret', 'apiKey', 'password', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'x-api-key', 'AWS_ACCESS_KEY_ID', 'Authorization', 'DB_PASSWORD', 'KEY']) assert.equal(isSecretName(n), true, n);
  for (const n of ['monkey', 'keyboard', 'primaryKey', 'TURKEY', 'KEYBOARD', 'NODE_ENV', 'PATH', 'user', 'name', '']) assert.equal(isSecretName(n), false, n);
});

/* ─── ④ 공격 입력 — 10만 자가 정해진 시간 안에 끝난다 ─── */
const N = 100_000;
const rep = (unit, total = N) => unit.repeat(Math.ceil(total / unit.length)).slice(0, total);
const ATTACKS = {
  '같은 글자': 'a'.repeat(N),
  '공백만': ' '.repeat(N), '탭만': '\t'.repeat(N), '줄바꿈만': '\n'.repeat(N),
  'a= 반복': rep('a='), 'a: 반복': rep('a:'), 'KEY= 반복': rep('KEY='), 'password= 반복': rep('password='), 'token: 반복': rep('token: '),
  '긴 이름 + = 반복': rep(`${'_'.repeat(81)}=x `), '긴 대문자 이름': rep(`${'A'.repeat(80)}=x `), '이름 + 공백 10만': `${'a'.repeat(80)}${' '.repeat(N)}x`,
  '-p 반복': rep('-p'), ' -p 반복': rep(' -p'), 'mysql 반복': rep('mysql '), 'mysql -p 반복': rep('mysql -p '), 'mysql 뒤 긴 줄': `mysql ${'x '.repeat(N / 2)}`, '7z 반복': rep('7z '),
  'sshpass -p 반복': rep('sshpass -p '), 'sshpass 반복': rep('sshpass '),
  'Bearer 반복': rep('Bearer '), 'Bearer x 반복': rep('Bearer x'), 'Bearer + 공백': `Bearer${' '.repeat(N)}`, 'Bearer + 긴 토큰': `Bearer ${'a'.repeat(N)}`,
  'authorization: 반복': rep('authorization:'), 'authorization + 공백': `authorization${' '.repeat(N)}`, 'Authorization: Basic 반복': rep('Authorization: Basic '),
  'Cookie: 반복': rep('Cookie:'), 'Cookie + 공백': `Cookie${' '.repeat(N)}`,
  '://  반복': rep('://'), 'a:// 반복': rep('a://'), 'a. 반복(점 스킴)': rep('a.'), 'http://a: 반복': rep('http://a:'), 'http://a:b@ 반복': rep('http://a:b@'), 'http://a: + @ 반복': `http://a:${'@'.repeat(N)}`,
  '큰따옴표 반복': '"'.repeat(N), '작은따옴표 반복': "'".repeat(N), '닫히지 않는 큰따옴표': `--token "${'x '.repeat(N / 2)}`, '닫히지 않는 작은따옴표': `--password '${'x '.repeat(N / 2)}`,
  '--token " 반복': rep(' --token "'), "--token ' 반복": rep(" --token '"), '--token "\' 번갈아': rep(' --token " --token \''), '--password= 반복': rep(' --password='),
  '--cookie 반복': rep(' --cookie '), '-token 반복': rep(' -token '),
  'curl 반복': rep('curl '), 'curl -u 반복': rep('curl -u '), 'curl -u " 반복': rep('curl -u "a:'), "curl -u ' 반복": rep("curl -u 'a:"), 'curl 뒤 긴 줄': `curl ${'x '.repeat(N / 2)}`,
  'curl --user= 반복': rep('curl --user='),
  'BEGIN PRIVATE KEY 반복': rep('-----BEGIN PRIVATE KEY-----'), 'BEGIN + 대문자': `-----BEGIN ${'A'.repeat(N)}`, 'BEGIN 반복(끝 없음)': rep('-----BEGIN A PRIVATE KEY-----\nx\n'),
  'END 표지만 반복': rep('-----END PRIVATE KEY-----'),
  'ghp_ 반복': rep('ghp_'), 'ghp_ + 긴 본문': `ghp_${'a'.repeat(N)}`, 'github_pat_ 반복': rep('github_pat_'), 'glpat- 반복': rep('glpat-'), 'xoxb- 반복': rep('xoxb-'),
  'AKIA 반복': rep('AKIA'), 'AKIA + 긴 본문': `AKIA${'A'.repeat(N)}`, 'npm_ 반복': rep('npm_'), 'hf_ 반복': rep('hf_'),
  'sk- 반복': rep('sk-'), 'sk-ant- 반복': rep('sk-ant-'), 'AIza 반복': rep('AIza'), 'xai- 반복': rep('xai-'), '32자 16진 + 점': rep(`${'a'.repeat(32)}.`),
  'JWT eyJ- 반복(maskKeyLike)': rep('eyJ-'), 'JWT eyJ. 반복': rep('eyJ.'), 'JWT 두 토막 반복': rep(`eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.`), 'JWT 한 토막 + 긴 -': `eyJ${'-'.repeat(N)}`,
  'sk-ant- 대시 반복': rep('sk-ant-a-'), 'AIza 대시 반복': rep(`AIza${'a'.repeat(20)}-`), 'xai- 대시 반복': rep(`xai-${'a'.repeat(16)}-`),
  'BEGIN 종류가 다른 END': rep('-----BEGIN A PRIVATE KEY-----\n-----END B PRIVATE KEY-----\n'), 'BEGIN/END 번갈아': rep('-----BEGIN PRIVATE KEY----- x -----END PRIVATE KEY----- '),
  '긴 스킴 반복': rep(`${'a'.repeat(30)}://`), '://u: 반복': rep('://u:'), '://a:b 반복(@ 없음)': rep('://a:b'), '://a:b@ 반복': rep('://a:b@'), '공백 없는 긴 비밀번호': `://u:${'p'.repeat(N)}`,
  'mysql 줄마다': rep('mysql -u x\n'), 'curl 줄마다': rep('curl x\n'), 'mysql 줄마다 -p': rep('mysql -p x\n'), 'Cookie 줄마다': rep('Cookie: a\n'), '줄바꿈 + mysql': rep('\nmysql'),
  'sshpass -p " 반복': rep('sshpass -p "'), 'a=" 반복': rep('a="'), "a=' 반복": rep("a='"), '닫히지 않는 password="': `password="${'x'.repeat(N)}`, '줄마다 password="': rep('password="x\n'),
  '16진 같은 글자': 'a'.repeat(N), '- 반복': '-'.repeat(N), '= 반복': '='.repeat(N), ': 반복': ':'.repeat(N), '@ 반복': '@'.repeat(N), '* 반복': '*'.repeat(N),
};

const timeOf = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };
const LIMIT_MS = 500; // 실측 최대 ~80ms(부하 평균 19의 맥) — CI가 3~5배 느려도 넘지 않고, 이차 시간(4만 자에서 이미 1초 이상)은 확실히 넘는다

for (const [name, input] of Object.entries(ATTACKS)) {
  test(`공격 입력 ${(input.length / 1000).toFixed(0)}K자: ${name} — ${LIMIT_MS}ms 안에 끝난다`, () => {
    const best = Math.min(timeOf(() => maskSecrets(input)), timeOf(() => maskSecrets(input))); // 부하 한 번에 흔들리지 않게 두 번 중 빠른 쪽
    assert.ok(best < LIMIT_MS, `${best.toFixed(0)}ms — 이차 시간 의심(입력 ${input.length}자)`);
  });
}

// 단계 요약은 64KB까지만 가리므로(상한) 입력이 얼마나 커도 비용이 묶인다 — 상한을 없애면 아래가 red.
test('단계 요약(detailForTool)은 입력이 얼마나 커도 빠르다 — 공격 입력 10만 자', () => {
  const REPRESENTATIVE = ['같은 글자', 'curl 반복', 'mysql 반복', 'a. 반복(점 스킴)', 'JWT eyJ- 반복(maskKeyLike)', '닫히지 않는 큰따옴표', 'BEGIN + 대문자', '--token " 반복'];
  for (const [name, input] of Object.entries(ATTACKS)) {
    const calls = [['Bash', { command: input }]];
    if (REPRESENTATIVE.includes(name)) calls.push(['Bash', { command: 'x', description: input }], ['Grep', { pattern: input }], ['WebSearch', { query: input }], ['Read', { file_path: input }]);
    for (const [tool, arg] of calls) {
      const best = Math.min(timeOf(() => detailForTool(tool, arg, { display: true })), timeOf(() => detailForTool(tool, arg, { display: true })));
      assert.ok(best < LIMIT_MS, `${tool}/${name}: ${best.toFixed(0)}ms`);
    }
  }
});
test('단계 요약은 수 MB 입력에서도 상한(64KB)까지만 가린다', () => {
  const huge = rep('curl -u a:b ', 5_000_000);
  assert.ok(timeOf(() => detailForTool('Bash', { command: huge })) < LIMIT_MS, '5MB 입력이 상한 없이 통째로 가려진다');
});

/* ─── maskKeyLike(runners/shared.mjs) — JWT 갈래를 앞 고정으로 바꿔도 지금까지 가리던 것은 그대로 가린다 ─── */
const JWT = 'eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE';
test('maskKeyLike: JWT는 공백·=·따옴표·콜론·줄 처음 뒤에서 가려지고, 이어진 평범한 글은 남는다', () => {
  for (const pre of ['', ' ', '=', '"', "'", ':', '\n', '(', '/', 'Bearer ', 'token=']) {
    const out = maskKeyLike(`x ${pre}${JWT} tail`);
    assert.ok(!out.includes('FAKEFAKE'), `JWT가 남았다(앞 ${JSON.stringify(pre)}): ${out}`);
    assert.ok(out.endsWith(' tail'));
  }
  assert.equal(maskKeyLike(JWT), 'sk-***');
  assert.equal(maskKeyLike(`${JWT}.extra`), 'sk-***.extra'); // 끝 \b 뒤의 점은 종전대로
});
test('maskKeyLike: 다른 벤더 키는 종전대로 가린다', () => {
  for (const k of ['sk-ant-api03-FAKEFAKEFAKEFAKE', 'sk-FAKEFAKEFAKEFAKEFAKE', 'AIzaFAKEFAKEFAKEFAKEFAKEFAKE', 'xai-FAKEFAKEFAKEFAKE', `${'a'.repeat(32)}.FAKEFAKEFAKEFAKE`]) assert.equal(maskKeyLike(`a ${k} b`), 'a sk-*** b', k);
});
test('maskKeyLike: eyJ- 반복 10만 자도 빠르다(고치기 전 8초 이상)', () => {
  for (const input of [rep('eyJ-'), rep('eyJ-a'), `x${rep('-eyJ')}`]) assert.ok(timeOf(() => maskKeyLike(input)) < LIMIT_MS);
});

/* ─── URL 비밀번호: 스킴이 길어도·어떤 스킴이든 가린다(스킴 길이를 묶으면 postgresql+asyncpg://가 새던 회귀) ─── */
test('URL 비밀번호 — postgresql+asyncpg·postgresql+psycopg2·mongodb+srv·아주 긴 스킴·점/하이픈 스킴', () => {
  for (const scheme of ['postgresql+asyncpg', 'postgresql+psycopg2', 'mongodb+srv', 'mssql+pyodbc', 'redis', 'amqps', 'a'.repeat(40), 'com.example.my-custom-scheme+x', 'git+ssh', 'HTTPS']) {
    const url = `${scheme}://admin:S3cretFAKEpw@db.example.test:5432/app`;
    const out = maskSecrets(`run ${url} now`);
    assert.ok(!out.includes('S3cretFAKEpw'), `${scheme}: 비밀번호가 남았다: ${out}`);
    assert.ok(out.includes(`${scheme}://admin:***@db.example.test:5432/app`), `${scheme}: ${out}`);
  }
});

/* ─── 가리는 범위가 옛 규칙보다 줄지 않는다 — 옛 규칙(feat/turn-trace 1e9333bd maskSecrets, 이차 시간 버전)을 그대로 옮겨 같은 입력에 돌린다 ─── */
const OLD_KV = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}\]]+)/g;
const oldMasked = (v) => /^(["'])?(?:\*+|sk-\*\*\*)\1?$/.test(v);
function oldMaskSecrets(s) { // 느리다(ReDoS) — 짧은 입력의 기준값으로만 쓴다
  let out = String(s);
  out = out.replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, '-----BEGIN $1PRIVATE KEY----- *** -----END $1PRIVATE KEY-----');
  out = maskKeyLike(out);
  out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  out = out.replace(/\b((?:Set-)?Cookie)(\s*:\s*)[^\n]+/gi, '$1$2***');
  out = out.replace(/(\s--?(?:password|passwd|pass|token|api-?key|secret|client-secret|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, (m, head, val) => (oldMasked(val) ? m : `${head}***`));
  out = out.replace(/^(.*\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b.*?\s-p)(?!\s)(\S+)/gim, '$1***');
  out = out.replace(/(\bsshpass\s+-p\s+)(\S+)/g, '$1***');
  out = out.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g, '$1$2:***');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@');
  out = out.replace(OLD_KV, (m, q, name, sep, val) => {
    if (!isSecretName(name) || oldMasked(val) || /^(Bearer|Basic|Token)$/.test(val)) return m;
    return `${q}${name}${q}${sep}${val.startsWith('"') ? '"***"' : val.startsWith("'") ? "'***'" : '***'}`;
  });
  return out;
}
const PW = 'FAKEpass12345';
const LONG_GAP = 'x'.repeat(400);
const SUPERSET = [
  // [입력, 가려져야 하는 조각]
  [`-----BEGIN RSA PRIVATE KEY-----\n${PW}\n-----END RSA PRIVATE KEY-----`, PW], [`-----BEGIN EC PRIVATE KEY-----\n${PW}\n-----END DSA PRIVATE KEY-----\n${PW}2`, `${PW}2`],
  [`-----BEGIN ${'A'.repeat(60)} PRIVATE KEY-----\n${PW}`, PW], [`-----BEGIN PRIVATE KEY-----\n${PW}`, PW],
  [`Authorization: Basic ${PW}`, PW], [`echo Basic ${PW}`, PW], [`Authorization: Token ${PW}`, PW], [`echo Token ${PW}`, PW], [`Authorization:\nBearer ${PW}`, PW], [`X Bearer\t${PW}`, PW],
  [`Cookie: a="x y"; b=${PW}`, PW], [`curl -H 'Cookie: sid=${PW}' https://x.test`, PW], [`Set-Cookie:\n  sid=${PW}`, PW], [`COOKIE : ${PW}`, PW],
  [`tool --token\n${PW}`, PW], [`tool --password\t${PW}`, PW], [`tool\t--secret ${PW}`, PW], [`tool --client-secret '${PW} two'`, PW], [`tool --api-key "${PW}"`, PW], [`tool --auth-token=${PW}`, PW],
  [`mysql --host=db ${LONG_GAP} -p${PW} mydb`, PW], [`mysqldump --single-transaction -u root -p${PW} mydb`, PW], [`/usr/bin/mariadb -p${PW}`, PW], [`FOO=1 mariadb-dump -p${PW}`, PW],
  [`sshpass -p ${PW} ssh h`, PW], [`sshpass  -p\t${PW} ssh h`, PW],
  [`curl ${LONG_GAP} -u admin:${PW} https://x.test`, PW], [`curl -s  --user  admin:${PW} https://x.test`, PW], [`/usr/bin/curl -u admin:${PW} x`, PW],
  [`redis://default:${PW}@host`, PW], [`amqps://u:${PW}@h`, PW], [`a.b+c-d://u:${PW}@h`, PW], [`${'z'.repeat(40)}://u:${PW}@h`, PW], [`postgresql+asyncpg://admin:${PW}@h/db`, PW], [`mongodb+srv://u:${PW}@c0.example.test/x`, PW],
  [`password  =  ${PW}`, PW], [`token:\n   ${PW}`, PW], [`API_KEY = "${PW}"`, PW], ['"password" : "' + PW + '"', PW], [`DATABASE_URL=${PW}`, PW], [`{"client_secret":'${PW}'}`, PW],
  [`export OPENAI_API_KEY=sk-FAKEFAKEFAKEFAKEFAKE000`, 'FAKEFAKEFAKE'], [`x-api-key:${PW}`, PW], [`GITHUB_TOKEN="${PW}" run`, PW],
];
test('가리는 범위가 옛 규칙보다 줄지 않는다 — 옛 규칙이 가리는 입력은 새 규칙도 가린다', () => {
  for (const [input, piece] of SUPERSET) {
    assert.ok(!oldMaskSecrets(input).includes(piece), `사전 확인: 옛 규칙이 이 사례를 가리지 못한다 — 사례를 고쳐라: ${JSON.stringify(input.slice(0, 80))}`);
    const out = maskSecrets(input);
    assert.ok(!out.includes(piece), `옛 규칙은 가리던 비밀이 남았다: ${JSON.stringify(input.slice(0, 120))} → ${JSON.stringify(out.slice(0, 160))}`);
  }
});

/* ─── 창을 두지 않은 가림 = 전체를 가린 뒤 자른 결과 ─── */
const fullThenCut = (cmd) => maskSecrets(cmd).replace(/\s+/g, ' ').slice(0, 48);
const BOUNDARY_SECRETS = [
  (p) => `${p} --token ${T32} tail`, (p) => `${p} -H "Authorization: Bearer ${T32}"`, (p) => `${p} ghp_${T32}${F}`, (p) => `${p} postgresql://admin:S3cretFAKEpw@db.example.test/app`,
  (p) => `${p} mysql -u root -pFAKEpass12345 mydb`, (p) => `${p} curl -u admin:FAKEpass12345 https://x.test`, (p) => `${p} OPENAI_API_KEY=${T32} node a.js`, (p) => `${p} ${JWT}`,
  (p) => `${p} -----BEGIN PRIVATE KEY-----\n${T32}\n-----END PRIVATE KEY-----`, (p) => `${p} AKIAFAKEFAKEFAKEFAKE`, (p) => `${p} Cookie: sid=${T32}`,
  (p) => `${p} postgresql+asyncpg://admin:S3cretFAKEpw@db.example.test/app`, (p) => `${p} {"password": "${T32}"}`,
];
test('단계 요약 = 전체를 가린 뒤 자른 결과 — 비밀 종류 × 경계 위치(앞 글자 0~70개) × 뒤에 긴 글이 붙은 경우(상한 안·밖)', () => {
  for (const [i, make] of BOUNDARY_SECRETS.entries()) {
    for (let pad = 0; pad <= 70; pad += 1) {
      const head = 'x'.repeat(pad);
      for (const tail of ['', `\n${'y '.repeat(2500)}`, ...(pad % 10 === 0 ? [`\n${'y '.repeat(40_000)}`] : [])]) { // 마지막은 64KB 상한 밖(시간을 아끼려 10칸마다)
        const cmd = make(head) + tail;
        const got = detailForTool('Bash', { command: cmd });
        assert.equal(got, fullThenCut(cmd), `종류 ${i} pad=${pad} tail=${tail.length}자`);
        assert.ok(!got.includes('FAKE'), `종류 ${i} pad=${pad}: 비밀 조각이 남았다`);
      }
    }
  }
});

/* ─── 상한(64KB) 근처·밖에서 비밀 조각이 앞 48자로 당겨지지 않는다 — 앞쪽 큰 비밀이 ***로 줄어도 ─── */
const CAP = 65_536;
test('상한에 걸친 URL 비밀번호: 앞쪽 큰 비밀이 줄어든 뒤 `@` 앞에서 잘려도 조각이 보이지 않는다', () => {
  for (const cut of [1, 6, 10, 14]) { // 비밀번호 중간에서 잘리는 위치 여러 곳
    const lead = '--token ';
    const url = ' postgresql://admin:';
    const cmd = `${lead}${'S'.repeat(CAP - cut - lead.length - url.length)}${url}FAKEpw0000FAKE@host/db`;
    assert.equal(cmd.indexOf('FAKE'), CAP - cut, '시험 구성: 비밀번호 조각이 상한 바로 앞에서 시작해야 한다');
    const got = detailForTool('Bash', { command: cmd });
    assert.ok(!/FAKE|SSS/.test(got), `cut=${cut}: 조각이 보인다: ${JSON.stringify(got)}`);
  }
});
test('상한 밖까지 이어지는 따옴표 비밀: 따옴표가 안 닫혀도 앞 조각이 보이지 않는다(JSON·--token·KEY=·curl -u) — 값에 공백이 들어 있어도', () => {
  const big = 'SECRETWORD '.repeat(7000); // 공백이 든 값 — 끝나지 않은 따옴표를 첫 단어까지만 가리면 나머지가 보인다
  for (const cmd of [`{"password": "${big}"}`, `curl --token "${big}" x`, `curl --password '${big}' x`, `DB_PASSWORD="${big}" run`, `curl -u "admin:${big}" x`, `sshpass -p "${big}" ssh h`, `mysql -p"${big}" db`]) {
    const got = detailForTool('Bash', { command: cmd });
    assert.ok(!got.includes('SECRETWORD'), `조각이 보인다: ${JSON.stringify(got)}`);
  }
  // 위 시험이 헛돌지 않는지 — 같은 입력을 maskSecrets에 상한만큼 잘라 넣어도 값이 통째로 가려진다(끝나지 않은 따옴표는 입력 끝까지가 값)
  const cutBig = big.slice(0, 60_000);
  for (const cmd of [`{"password": "${cutBig}`, `curl --token "${cutBig}`, `curl --password '${cutBig}`, `DB_PASSWORD="${cutBig}`, `curl -u "admin:${cutBig}`, `sshpass -p "${cutBig}`, `mysql -p"${cutBig}`]) {
    assert.ok(!maskSecrets(cmd).includes('SECRETWORD'), `잘린 입력의 값이 남았다: ${cmd.slice(0, 30)}`);
  }
});
test('상한 안에서 끝나는 큰 비밀 뒤의 평범한 글은 그대로 보인다(상한 밖 입력이 아닐 때 버리지 않는다)', () => {
  const out = detailForTool('Bash', { command: `--token ${'S'.repeat(30_000)} then ls -la` });
  assert.equal(out, '--token *** then ls -la');
});
test('상한을 넘으면 가린 결과의 끝 8KB를 버린다 — 큰 입력의 앞 48자는 그대로 보인다', () => {
  const out = detailForTool('Bash', { command: `git status --short ${'x'.repeat(100_000)}` });
  assert.equal(out, 'git status --short xxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
});
