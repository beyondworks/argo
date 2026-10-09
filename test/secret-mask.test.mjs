// maskSecrets(src/secret-mask.mjs) — ① 패턴마다 가린다 ② 평범한 글은 그대로 ③ 두 번 돌려도 같다 ④ 공격 입력(같은 글자·반복 머리·닫히지 않는 따옴표 10만 자)에서도 정해진 시간 안에 끝난다.
// ④가 이 시험의 핵심이다: 같은 목적의 옛 규칙은 `curl `·`mysql ` 반복 4만 자에서 100ms, `a.a.a.` 4만 자에서 1.4초(이차 시간)였다 — 정규식 서비스 거부(ReDoS).
// 가짜 값만 쓴다(FAKE 반복).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, isSecretName } from '../src/secret-mask.mjs';
import { maskKeyLike } from '../src/runners/shared.mjs';
import { REF_MAIN_KEY_LIKE, refMaskSecrets } from './helpers/mask-reference.mjs';
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
  ['ghp_', `ghp_${T32}${F}`, F, 'sk-***'],
  ['gho_', `gho_${T32}`, F, 'sk-***'],
  ['github_pat_', `github_pat_${T32}_${F}`, F, 'sk-***'],
  ['glpat-', `glpat-${T32}`, F, 'sk-***'],
  ['xoxb-', `${XOX}b-1234567890-FAKEFAKEFAKE`, 'FAKEFAKE', 'sk-***'],
  ['xoxp-', `${XOX}p-1234567890-1234567890-FAKEFAKE`, 'FAKEFAKE', 'sk-***'],
  ['AKIA', 'AKIAFAKEFAKEFAKEFAKE', 'FAKEFAKE', 'sk-***'],
  ['ASIA', 'ASIAFAKEFAKEFAKEFAKE', 'FAKEFAKE', 'sk-***'],
  ['npm_', `npm_${F.repeat(5).slice(0, 36)}`, F, 'sk-***'],
  ['hf_', `hf_${F.repeat(5)}`, F, 'sk-***'],
  ['sk- (maskKeyLike)', 'sk-FAKEFAKEFAKEFAKEFAKE000', 'FAKEFAKE', 'sk-***'],
  ['JWT (maskKeyLike)', 'eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE', 'FAKEFAKE', 'sk-***'],
  ['--password 값', 'tool --password FAKEpass12345 run', 'FAKEpass12345', '--password ***'],
  ['--password=값', 'tool --password=FAKEpass12345 run', 'FAKEpass12345', '--password=***'],
  ['--passwd 값', 'tool --passwd FAKEpass12345', 'FAKEpass12345', '--passwd ***'],
  ['--http-password 값', 'wget --http-password FAKEpass12345 u', 'FAKEpass12345', '--http-password ***'],
  ['--token 값', 'tool --token FAKEpass12345 run', 'FAKEpass12345', '--token ***'],
  ['--token 값 자리에 다음 플래그', 'cli --token --token FAKEpass12345 run', 'FAKEpass12345', '--token ***'],
  ['--token mysql(도구 이름이 값 자리) 뒤 -p', 'cli --token mysql -u root -pFAKEpass12345 db', 'FAKEpass12345', '-p***'],
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
    'export NODE_ENV=production', 'KEYBOARD=us node a.js', 'primaryKey=id', 'echo token refreshed', 'Bearer token is required',
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

test('isSecretName: 옛 세 규칙 그대로 — 비밀 이름(소문자가 섞인 *_KEY 포함)만, monkey·keyboard·primaryKey는 아니다', () => {
  for (const n of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'client_secret', 'apiKey', 'password', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'x-api-key', 'AWS_ACCESS_KEY_ID', 'Authorization', 'DB_PASSWORD', 'KEY', 'next_public_supabase_anon_KEY', 'xSUPABASE_SERVICE_ROLE_KEY', 'token-SUPABASE_SERVICE_ROLE_KEY', 'MONKEY', 'TURKEY']) assert.equal(isSecretName(n), true, n); // MONKEY·TURKEY도 옛 규칙이 가리던 이름이다(줄이지 않는다)
  for (const n of ['monkey', 'keyboard', 'primaryKey', 'KEYBOARD', 'NODE_ENV', 'PATH', 'user', 'name', '']) assert.equal(isSecretName(n), false, n);
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

/* ─── 가리는 범위가 줄지 않는다 — 기준 구현 둘을 시험 안에 그대로 옮겨 같은 입력에 돌린다 ───
   (a) 지금 origin/main의 maskKeyLike  (b) feat/turn-trace 1e9333bd의 maskSecrets(+ 그 커밋의 maskKeyLike, 접두사 토큰이 더해진 것). 둘 다 이차 시간이라 짧은 입력에서만 쓴다.
   규칙: 기준이 가리는 입력은 새 구현도 모두 가린다. 앞뒤 글자를 바꿔 가며(-·.·=·:·따옴표·괄호·줄바꿈·단어 글자) 같은 비밀을 놓는다. */
const PRE = ['', ' ', '-', '.', '=', ':', '"', "'", '(', '/', ',', ';', '[', '{', '@', '*', '<', '\n', '\t', '_', 'x', 'x-', 'x.', 'x_', 'token-', 'token.', 'token=', 'token:', 'token="', "token='", '--token ', '-H "Authorization: '];
const SUF = ['', ' ', '.', '-', '"', "'", ',', ')', '\n', '_', 'x', '.x', '-x'];
const PW2 = 'FAKEpass12345';
const KEY_SHAPES = [ // [비밀 모양, 가려져야 하는 조각]
  ['eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE', 'FAKEFAKE'], ['eyJ-FAKE_FAKE-FAKE.FAKE_FAKE-FAKE.FAKE-FAKE_FAKE', 'FAKE_FAKE'], ['eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE-', 'FAKEFAKE'],
  ['sk-ant-api03-FAKEFAKEFAKE', 'FAKEFAKEFAKE'], ['sk-FAKEFAKEFAKEFAKEFAKE', 'FAKEFAKEFAKE'], [`AIza${'FAKE'.repeat(6)}`, 'FAKEFAKE'], [`xai-${'FAKE'.repeat(5)}`, 'FAKEFAKE'],
  [`${'a'.repeat(32)}.FAKEFAKEFAKEFAKE`, 'FAKEFAKEFAKE'], [`ghp_${'FAKE0000'.repeat(5)}`, 'FAKE0000'], [`github_pat_${'FAKE0000'.repeat(4)}`, 'FAKE0000'], [`glpat-${'FAKE0000'.repeat(3)}`, 'FAKE0000'],
  [`${XOX}b-1234567890-FAKEFAKEFAKE`, 'FAKEFAKE'], ['AKIAFAKEFAKEFAKEFAKE', 'FAKEFAKE'], [`npm_${'FAKE0000'.repeat(5).slice(0, 36)}`, 'FAKE0000'], [`hf_${'FAKE0000'.repeat(5)}`, 'FAKE0000'],
];
function everyShape(shapes, ref, now, label) {
  let checked = 0;
  for (const [shape, piece] of shapes) for (const pre of PRE) for (const suf of SUF) {
    const input = `${pre}${shape}${suf}`;
    if (ref(input).includes(piece)) continue; // 기준도 못 가리는 입력은 비교 대상이 아니다
    checked += 1;
    assert.ok(!now(input).includes(piece), `${label}: 기준이 가리던 입력이 새 구현에서 새고 있다 ${JSON.stringify(input)} → ${JSON.stringify(now(input))}`);
  }
  return checked;
}
test('(a) maskKeyLike: 지금 main이 가리던 입력은 새 구현도 모두 가린다 — 비밀 15종 × 앞 32 × 뒤 13', () => {
  const n = everyShape(KEY_SHAPES, REF_MAIN_KEY_LIKE, maskKeyLike, 'maskKeyLike');
  assert.ok(n > 3000, `비교가 헛돈다 — 기준이 가린 입력 ${n}개`);
});
test('maskKeyLike: `token-eyJ…`처럼 `-`·`.` 뒤에서 시작하는 JWT도 가린다(앞 고정으로 막았던 회귀)', () => {
  for (const pre of ['token-', 'a.', '--', 'x-y-', '-']) assert.equal(maskKeyLike(`${pre}${KEY_SHAPES[0][0]}`), `${pre}sk-***`);
  assert.equal(maskKeyLike(`${KEY_SHAPES[0][0]}.extra`), 'sk-***.extra'); // 끝 \b 뒤의 점은 종전대로
  assert.equal(maskKeyLike('xeyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE'), 'xeyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE'); // 단어 글자 바로 뒤는 종전대로 가리지 않는다
});
test('maskKeyLike: 다른 벤더 키는 종전대로 가린다', () => {
  for (const [k, piece] of KEY_SHAPES) { const out = maskKeyLike(`a ${k} b`); assert.ok(out.startsWith('a sk-***') && out.endsWith(' b') && !out.includes(piece), `${k} → ${out}`); }
  for (const [k] of KEY_SHAPES.filter(([x]) => !x.endsWith('-'))) assert.equal(maskKeyLike(`a ${k} b`), 'a sk-*** b', k);
});
test('maskKeyLike: eyJ- 반복 10만 자도 빠르다(고치기 전 8초 이상)', () => {
  for (const input of [rep('eyJ-'), rep('eyJ-a'), `x${rep('-eyJ')}`, rep('eyJ.'), rep(`eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.`)]) assert.ok(timeOf(() => maskKeyLike(input)) < LIMIT_MS);
});

// 차분 퍼즈 — 무작위로 이어 붙인 글(JWT 머리·sk-·점·대시·밑줄·공백…) 40만 건에서, main이 가린 10자 조각은 새 maskKeyLike도 가린다.
// 키 모양을 JWT보다 먼저 가리면 JWT 속 `sk-ant-…` 조각이 `sk-***`가 돼 `*`가 JWT를 끊고 머리(eyJ…)가 남는다 — 이 퍼즈가 그 순서 실수를 잡는다(고정 씨앗 12345에서 3건).
test('maskKeyLike 차분 퍼즈: main이 가린 조각은 새 구현도 가린다 — 무작위 40만 건', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const atoms = ['eyJ', 'eyJ', 'eyJ', 'sk-', 'sk-ant-', 'AIza', 'xai-', '-', '-', '.', '.', '_', ' ', '\n', '"', '=', ':', '/', 'a', 'Z', '0', '9', 'abcdefghij', 'ABCDEFGHIJKL', '0123456789', 'xxxxxxxxxxxxxxxxxxxx', 'f'.repeat(32), '--', '..', 'é', '+'];
  const windows = (str) => { const out = new Set(); for (const run of str.match(/[\w-]{10,}/g) ?? []) for (let i = 0; i + 10 <= run.length; i += 1) out.add(run.slice(i, i + 10)); return out; };
  const bad = [];
  for (let n = 0; n < 400_000 && bad.length < 5; n += 1) {
    let input = ''; const len = 1 + Math.floor(rnd() * 14);
    for (let k = 0; k < len; k += 1) input += pick(atoms);
    const ref = REF_MAIN_KEY_LIKE(input); const cur = maskKeyLike(input);
    if (ref === cur) continue;
    for (const w of windows(input)) if (!ref.includes(w) && cur.includes(w)) { bad.push(`${JSON.stringify(input)} → ref ${JSON.stringify(ref)} / new ${JSON.stringify(cur)}`); break; }
  }
  assert.deepEqual(bad, [], `main이 가리던 조각이 샌다:\n${bad.join('\n')}`);
});

// 한 규칙의 값이 다른 규칙의 머리 글자를 품는 입력 — 규칙을 차례로 적용하면 앞 규칙이 그 글자를 바꿔 뒤 규칙이 비밀을 놓친다(차분 퍼즈에서 찾음). 규칙마다 같은 글에서 자리를 모으므로 모두 가려야 한다.
test('겹치고 붙은 모양: 한 규칙의 값이 다른 규칙의 머리를 품어도 비밀이 남지 않는다', () => {
  const V = 'QZXWqxz12345'; // 키워드를 품지 않은 가짜 비밀
  const JW = 'eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKEFAKEFAKE';
  for (const [input, piece] of [
    [`${JW}-----BEGIN RSA PRIVATE KEY-----\nFAKEPEMBODYLINE12\n-----END RSA PRIVATE KEY-----`, 'FAKEPEMB'], // JWT 끝에 PEM 시작 표지가 붙음 — PEM이 먼저
    [`Bearer ghp_${'FAKE0000'.repeat(3)}sk-FAKEFAKEFAKEFAKEFAKE`, 'FAKEFAKE'], // 키 모양이 토큰 앞쪽만 가림 — 남은 뒤쪽까지
    [`x asyncpg://PASSWORD=@${V}`, V], [`ptoken='PASSWORD=${V} tail`, V], [`a:'next_public_KEY=${V}`, V], // 비밀이 아닌 이름의 값(닫히지 않은 따옴표 포함)이 안쪽 이름을 삼키지 않음
    [`Token \ntoken=Token ${V}x`, V], [`Bearer Bearer ${V}${V}`, V], // 값이 다음 머리를 품음
    [`sshpass -p 'abc'-x${V} ssh h`, V], [`mysql -u r -p'abc'-x${V} db`, V], [`cli --password "abc"${V}`, V], // 따옴표 값 바로 뒤에 붙은 글자도 같은 낱말
    [`cli --token mysql -u root -p${V} db`, V], [`cli --token --token ${V}`, V], // 인자의 값 자리에 도구 이름·다음 플래그
    [`apiKey: --password=\n${V}`, V], // 비밀 KEY의 값 끝에서 시작하는 다음 머리
  ]) {
    const out = maskSecrets(input);
    assert.ok(!out.includes(piece), `새어 나갔다: ${JSON.stringify(input)} → ${JSON.stringify(out)}`);
    assert.equal(maskSecrets(out), out, `멱등: ${JSON.stringify(out)}`);
  }
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

/* ─── (b) maskSecrets: 1e9333bd가 가리던 입력은 새 구현도 모두 가린다 ─── */
const LONG_GAP = 'x'.repeat(400);
const SECRET_SHAPES = [ // [비밀 모양, 가려져야 하는 조각] — 앞뒤 글자를 PRE·SUF로 바꿔 놓는다
  ...KEY_SHAPES,
  [`Bearer ${PW2}`, PW2], [`Basic ${PW2}`, PW2], [`Token ${PW2}`, PW2], [`Authorization: Bearer ${PW2}`, PW2], [`Authorization: Basic ${PW2}`, PW2], [`Authorization:\nBearer ${PW2}`, PW2],
  [`Cookie: a="x y"; b=${PW2}`, PW2], [`Set-Cookie:\n  sid=${PW2}`, PW2], [`COOKIE : ${PW2}`, PW2],
  [` --token ${PW2}`, PW2], [` --token\n${PW2}`, PW2], [` --password=${PW2}`, PW2], [` --password\t${PW2}`, PW2], [` --api-key "${PW2}"`, PW2], [` --client-secret '${PW2} two'`, PW2], [`\t--secret ${PW2}`, PW2],
  [`mysql --host=db ${LONG_GAP} -p${PW2} mydb`, PW2], [`mysqldump -u root -p${PW2} mydb`, PW2], [`/usr/bin/mariadb -p${PW2}`, PW2], [`FOO=1 mariadb-dump -p${PW2}`, PW2],
  [`sshpass -p ${PW2} ssh h`, PW2], [`sshpass  -p\t${PW2} ssh h`, PW2],
  [`curl ${LONG_GAP} -u admin:${PW2} https://x.test`, PW2], [`curl -s  --user  admin:${PW2} https://x.test`, PW2], [`/usr/bin/curl -u admin:${PW2} x`, PW2],
  [`redis://default:${PW2}@host`, PW2], [`amqps://u:${PW2}@h`, PW2], [`a.b+c-d://u:${PW2}@h`, PW2], [`${'z'.repeat(40)}://u:${PW2}@h`, PW2], [`postgresql+asyncpg://admin:${PW2}@h/db`, PW2], [`mongodb+srv://u:${PW2}@c0.example.test/x`, PW2],
  [`-----BEGIN RSA PRIVATE KEY-----\n${PW2}\n-----END RSA PRIVATE KEY-----`, PW2], [`-----BEGIN EC PRIVATE KEY-----\n${PW2}\n-----END DSA PRIVATE KEY-----\n${PW2}2`, `${PW2}2`], [`-----BEGIN PRIVATE KEY-----\n${PW2}`, PW2],
  [`password  =  ${PW2}`, PW2], [`token:\n   ${PW2}`, PW2], [`API_KEY = "${PW2}"`, PW2], [`"password" : "${PW2}"`, PW2], [`DATABASE_URL=${PW2}`, PW2], [`{"client_secret":'${PW2}'}`, PW2], [`GITHUB_TOKEN="${PW2}"`, PW2], [`x-api-key:${PW2}`, PW2],
];
test('(b) maskSecrets: feat/turn-trace 1e9333bd가 가리던 입력은 새 구현도 모두 가린다 — 비밀 모양 × 앞 32 × 뒤 13', () => {
  const n = everyShape(SECRET_SHAPES, refMaskSecrets, maskSecrets, 'maskSecrets');
  assert.ok(n > 8000, `비교가 헛돈다 — 기준이 가린 입력 ${n}개`);
});
test('기준(1e9333bd)이 놓치던 것도 가린다 — BEARER·bearer·Authorization: bearer/basic/token 소문자, 접두사 뒤 `-`·`.`·`=`·`:`·따옴표', () => {
  for (const [input, piece] of [
    [`BEARER ${PW2}`, PW2], [`bearer ${PW2}`, PW2], [`Authorization: bearer ${PW2}`, PW2], [`authorization: basic ${PW2}`, PW2], [`AUTHORIZATION: Token ${PW2}`, PW2], [`curl -H "authorization: bearer ${PW2}"`, PW2],
    [`x-${KEY_SHAPES[0][0]}`, 'FAKEFAKE'], [`k.${KEY_SHAPES[0][0]}`, 'FAKEFAKE'], [`k=${KEY_SHAPES[0][0]}`, 'FAKEFAKE'], [`k:${KEY_SHAPES[0][0]}`, 'FAKEFAKE'], [`"${KEY_SHAPES[0][0]}"`, 'FAKEFAKE'],
  ]) {
    const out = maskSecrets(input);
    assert.ok(!out.includes(piece), `새어 나갔다: ${JSON.stringify(input)} → ${JSON.stringify(out)}`);
    assert.equal(maskSecrets(out), out, '멱등');
  }
});

/* ─── 창을 두지 않은 가림 = 전체를 가린 뒤 자른 결과 ─── */
const fullThenCut = (cmd) => maskSecrets(cmd).replace(/\s+/g, ' ').slice(0, 48);
const JWT = KEY_SHAPES[0][0];
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

/* ─── 상한(64KB) 근처·밖에서 비밀 조각이 앞 48자로 당겨지지 않는다 — 앞쪽 큰 비밀이 ***로 줄어도, 조각이 8KB보다 길어도 ─── */
const CAP = 65_536;
test('상한에 걸친 URL 비밀번호: 앞쪽 큰 비밀이 줄어든 뒤 `@` 앞에서 잘려도 조각이 보이지 않는다 — 상한 앞 마지막 공백에서 자른다', () => {
  for (const cut of [1, 6, 10, 14]) { // 비밀번호 중간에서 잘리는 위치 여러 곳
    const lead = 'cli --token ';
    const url = ' postgresql://admin:';
    const cmd = `${lead}${'S'.repeat(CAP - cut - lead.length - url.length)}${url}FAKEpw0000FAKE@host/db`;
    assert.equal(cmd.indexOf('FAKE'), CAP - cut, '시험 구성: 비밀번호 조각이 상한 바로 앞에서 시작해야 한다');
    assert.equal(detailForTool('Bash', { command: cmd }), 'cli --token ***', `cut=${cut}`);
  }
});
test('잘린 자리에 걸린 조각이 8KB보다 길어도 보이지 않는다(공백 없는 긴 비밀번호·긴 사용자 정보)', () => {
  for (const frag of [` postgresql://admin:${'p'.repeat(30_000)}`, ` redis://${'u'.repeat(20_000)}:${'p'.repeat(20_000)}`, ` mongodb+srv://u:${'FAKE'.repeat(9000)}`]) {
    const cmd = `cli --token ${'S'.repeat(CAP - 12 - frag.length + 5000)}${frag}@h/db`; // 조각이 상한을 가로지른다
    assert.ok(cmd.length > CAP && cmd.indexOf(frag) < CAP, '시험 구성');
    const got = detailForTool('Bash', { command: cmd });
    assert.equal(got, 'cli --token ***', frag.slice(0, 30));
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
test('상한 안에서 끝나는 큰 비밀 뒤의 평범한 글은 그대로 보인다', () => {
  assert.equal(detailForTool('Bash', { command: `cli --token ${'S'.repeat(30_000)} then ls -la` }), 'cli --token *** then ls -la');
});
test('상한 자리가 토큰 한가운데면 그 토큰 앞 공백에서 자른다 — 평범한 큰 입력의 앞 48자는 그대로 보인다', () => {
  assert.equal(detailForTool('Bash', { command: `git status --short ${'x'.repeat(100_000)}` }), 'git status --short');
  assert.equal(detailForTool('Bash', { command: `${'word '.repeat(20_000)}tail` }), 'word '.repeat(20).slice(0, 48));
  assert.equal(detailForTool('Bash', { command: 'x'.repeat(100_000) }), ''); // 공백이 하나도 없으면 보여 줄 것이 없다(조각을 내지 않는다)
});

// #904 분리 검수(69502956) — MEDIUM 1·2, LOW 3·4
test('검수: curl --user 뒤 = 반복은 선형(10만 자 200ms 안), 대문자 DB 도구 -p도 가림, 비밀 이름 검색 명령은 읽힘, .7z 확장자는 도구 아님', () => {
  const t0 = Date.now();
  maskSecrets('curl --user' + '='.repeat(100_000) + ' x');
  assert.ok(Date.now() - t0 < 200, `curl --user= 반복 ${Date.now() - t0}ms`);
  const pw = 'Xq7Zp2Lw' + 'Rt4Vb8N9';
  assert.equal(maskSecrets(`MySQL -u root -p${pw} db`), 'MySQL -u root -p*** db');
  assert.equal(maskSecrets(`/usr/local/MySQL/bin/MYSQL -p${pw}`), '/usr/local/MySQL/bin/MYSQL -p***');
  assert.equal(maskSecrets(`.mariadb -p${pw}`), '.mariadb -p***');
  assert.equal(maskSecrets('grep -rn "password: " src/ && npm test'), 'grep -rn "password: " src/ && npm test');
  assert.equal(maskSecrets('rg "token=" .env.example'), 'rg "token=" .env.example');
  assert.equal(maskSecrets('tar -xf backup.7z && mkdir -pv restore'), 'tar -xf backup.7z && mkdir -pv restore');
  assert.equal(maskSecrets(`7z x a.7z -p${pw}`), '7z x a.7z -p***');
  assert.equal(maskSecrets(`{"password": "${pw}`), '{"password": "***');
  assert.equal(maskSecrets(`curl --user=admin:${pw} https://h`), 'curl --user=admin:*** https://h');
});
