// 작업 과정 가림의 정규식 서비스 거부(ReDoS) 방어 — 도구 결과에는 웹 페이지·파일처럼 외부가 만든 큰 글이 섞인다(보안 검토 2026-10-09).
// 패턴마다 공격 입력(같은 글자 10만 개, 비밀 머리말 10만 번 반복, 닫히지 않는 따옴표·PEM)을 넣어 한 번 가리는 데 200ms 안에 끝나는지 본다.
// 정규식은 동기 실행이라 시험 시간 제한으로 끊을 수 없다 — 고치기 전 코드는 이 파일 전체가 멈춘다(바깥 timeout으로 red 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-trace-redos-'));
const T = await import('../src/turn-trace.mjs');
const { maskKeyLike } = await import('../src/runners/shared.mjs');

const N = 100_000;
const ATTACKS = {
  'same char a': 'a'.repeat(N),
  'same char space then x': `${' '.repeat(N)}x`,
  'same char dash': '-'.repeat(N),
  'same char *': '*'.repeat(N),
  'a. run (url scheme)': 'a.'.repeat(N),
  'a= repeat': 'a='.repeat(N),
  'password= repeat': 'password='.repeat(N / 2),
  '-p repeat': ' -p'.repeat(N),
  '--password repeat': ' --password '.repeat(N),
  'Bearer repeat': 'Bearer '.repeat(N),
  'Bearer then spaces': `Bearer${' '.repeat(N)}`,
  ':// repeat': '://'.repeat(N),
  'x://a: repeat': 'x://a:'.repeat(N / 2),
  '-----BEGIN repeat': '-----BEGIN '.repeat(N),
  'BEGIN + capitals': `-----BEGIN ${'A'.repeat(N)}`,
  'PEM no END': `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEpAIBAAKCAQEA\n'.repeat(N / 4)}`,
  'eyJ- run (jwt)': 'eyJ-'.repeat(N),
  'eyJa. run (jwt)': 'eyJaaaaaaaaaaaa.'.repeat(N / 4),
  'mysql repeat': 'mysql '.repeat(N),
  'curl repeat': 'curl '.repeat(N),
  'Cookie then spaces': `Cookie${' '.repeat(N)}`,
  'unclosed quote value': `password="${'a'.repeat(N)}`,
  'unclosed quote repeat': ' --password "a'.repeat(N / 2),
  'sk- run': 'sk-'.repeat(N),
  'hex.': `${'0123456789abcdef'.repeat(N / 16)}.`,
  'key: spaces': `api_key${' '.repeat(N)}`,
};

for (const [name, input] of Object.entries(ATTACKS)) {
  test(`가림 200ms 안 — ${name} (${input.length.toLocaleString()}자)`, () => {
    const t0 = performance.now();
    T.maskSecrets(input);
    maskKeyLike(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${name}: ${ms.toFixed(0)}ms`);
  });
}

test('기록기 경로 — 큰 외부 결과·입력·생각도 상한만큼만 가리고 200ms 안', () => {
  const tr = T.createTrace({ wsId: 'redos', slug: 'a', source: 'routine' });
  const t0 = performance.now();
  for (const input of Object.values(ATTACKS)) {
    tr.toolStart({ id: 'x', name: 'Bash', input: { command: input } });
    tr.toolEnd('x', { result: input });
    tr.think(input);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 200 * Object.keys(ATTACKS).length, `전체 ${ms.toFixed(0)}ms`);
  tr.finish();
});

test('상한 경계 — 저장 상한 바로 앞에서 시작해 상한을 넘어가는 비밀도 가려진다(상한 자리가 든 줄 끝까지 가린 뒤 자른다)', () => {
  for (const [limit, secret] of [[8000, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'], [8000, 'Authorization: Bearer abcdefghijklmnopqrst'], [16_000, 'OPENAI_API_KEY=plain-value-123456'], [4000, 'postgresql://app:Sup3rS3cret@db/x']]) {
    for (const back of [1, 5, 12, 20, 40]) {
      const text = `${'x'.repeat(limit - back)} ${secret} tail`;
      const out = T.maskSecrets(text, limit);
      assert.ok(out.length <= limit, '상한 안');
      // 상한을 준 가림 = 전체를 가린 뒤 자른 것 — 경계에 걸친 비밀의 앞부분이 원문으로 남지 않는다
      assert.equal(out, T.maskSecrets(text).slice(0, limit), `${secret.slice(0, 12)} back=${back}`);
    }
  }
  // 상한 앞에서 끝나는 평범한 글은 그대로, 가림 결과도 종전과 같다
  assert.equal(T.maskSecrets('ls -la vault/notes', 8000), 'ls -la vault/notes');
  assert.equal(T.maskSecrets('OPENAI_API_KEY=plain-value-123', 8000), 'OPENAI_API_KEY=***');
  assert.equal(T.maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter'), '-----BEGIN RSA PRIVATE KEY----- *** -----END RSA PRIVATE KEY-----\nafter', 'PEM 뒤 글은 남는다');
  assert.equal(T.maskSecrets('-----BEGIN PRIVATE KEY-----\nMIIE (잘림)'), '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----', '닫히지 않은 PEM은 끝까지 가린다');
});

// ─── 두 번째 보안 검토(2026-10-09) — 상한 가림의 경계 노출·옛 규칙 대조 ───
// 1e9333bd(첫 보안 반영)의 가림을 그대로 옮긴 기준 구현 — 작은 입력에서만 돌린다(그 규칙은 큰 입력에서 길이의 제곱으로 느렸다).
// 아래 '비밀'은 모두 형식만 맞춘 가짜 값이다.
const OLD_KEY = /\b(sk-ant-[\w-]+|sk-[\w-]{16,}|AIza[\w-]{20,}|xai-[\w-]{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|[0-9a-f]{32}\.[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})\b/g;
const OLD_KV = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}\]]+)/g;
const oldMasked = (v) => /^(["'])?(?:\*+|sk-\*\*\*)\1?$/.test(v);
function oldMask(s) {
  let out = String(s);
  out = out.replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, '-----BEGIN $1PRIVATE KEY----- *** -----END $1PRIVATE KEY-----');
  out = out.replace(OLD_KEY, 'sk-***');
  out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  out = out.replace(/\b((?:Set-)?Cookie)(\s*:\s*)[^\n]+/gi, '$1$2***');
  out = out.replace(/(\s--?(?:password|passwd|pass|token|api-?key|secret|client-secret|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, (m, head, val) => (oldMasked(val) ? m : `${head}***`));
  out = out.replace(/^(.*\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b.*?\s-p)(?!\s)(\S+)/gim, '$1***');
  out = out.replace(/(\bsshpass\s+-p\s+)(\S+)/g, '$1***');
  out = out.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g, '$1$2:***');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@');
  out = out.replace(OLD_KV, (m, q, name, sep, val) => (!T.isSecretName(name) || oldMasked(val) || /^(Bearer|Basic|Token)$/.test(val) ? m : `${q}${name}${q}${sep}${val.startsWith('"') ? '"***"' : val.startsWith("'") ? "'***'" : '***'}`));
  return out;
}
// [입력, 비밀 조각들] — 옛 규칙이 가리던 것은 새 규칙도 모두 가린다
const CORPUS = [
  ['DB: postgresql+asyncpg://admin:FakePassw0rdXYZ@db.example.com/app', ['FakePassw0rdXYZ']],
  ['x.postgresql://u:fake-url-pw-123@h/db', ['fake-url-pw-123']],
  ['jdbc:mysql+srv://root:Zz9_fakepw@10.0.0.1:3306/x', ['Zz9_fakepw']],
  ['HTTP://USER:CapsFakePass1@host', ['CapsFakePass1']],
  ['Authorization: Bearer\n  abcdefghijklmnop12345', ['abcdefghijklmnop12345']],
  ['Bearer                  abcdefghijklmnopqrstu', ['abcdefghijklmnopqrstu']],
  ['Cookie:\n sid=cookie-across-line', ['cookie-across-line']],
  ['Cookie   :    sid=lots-of-spaces-cookie', ['lots-of-spaces-cookie']],
  ['Set-Cookie:\n  a=1; session=cookie-two-part another-part-xyz', ['cookie-two-part', 'another-part-xyz']], // KEY=VALUE가 첫 값만 무는 경우 — 쿠키 규칙이 줄 끝까지
  ['tool --password\n  NewlinePassArg', ['NewlinePassArg']],
  ['tool --password            SpacedPassArg', ['SpacedPassArg']],
  ['tool --token "multi\nline token value"', ['multi', 'line token value']],
  ['sshpass\t\t-p   TabSshPass ssh h', ['TabSshPass']],
  ['curl    -u    admin:CurlSpacedPw https://x', ['CurlSpacedPw']],
  ['echo hi; mysql -h db -pMyPw123 app; mysql -pSecondPw', ['SecondPw']],
  ['token-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', ['eyJzdWIiOiIxMjM0In0', 'abcdefghijklmnop']],
  ['Bad token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv end', ['eyJzdWIiOiIxMjM0NTY3ODkwIn0']],
  [`${'a'.repeat(100)}_password=LongNameValue123`, ['LongNameValue123']],
  ['{"apiKey": "abc123fakeval", "client_secret": "def456fakeval"}', ['abc123fakeval', 'def456fakeval']],
  ['export DB_PASSWORD="hunter2fake"', ['hunter2fake']],
  ["SECRET_TOKEN = 'quoted-single-fake'", ['quoted-single-fake']],
  ['-----BEGIN  RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAdoublespace\n-----END  RSA PRIVATE KEY-----', ['MIIEpAIBAAKCAQEAdoublespace']],
  ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHzBJBgkqhkiG9w0BBQ0\n-----END ENCRYPTED PRIVATE KEY-----', ['MIIFHzBJBgkqhkiG9w0BBQ0']],
  ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANopen', ['MIIEvQIBADANopen']],
  [`ghp_${'a'.repeat(36)} AKIA${'B'.repeat(16)} xoxb-1234567890-abcdefghij`, [`ghp_${'a'.repeat(10)}`, `AKIA${'B'.repeat(16)}`, 'xoxb-1234567890']],
  [`${'abcdef0123456789'.repeat(2)}.ABCDEFGHijklmnop`, ['ABCDEFGHijklmnop']],
];

test('옛 규칙 대조 — 1e9333bd가 가리던 입력은 새 규칙도 모두 가린다(긴 스킴·줄을 넘는 공백·긴 이름·PEM 변형 포함)', () => {
  let covered = 0;
  for (const [text, secrets] of CORPUS) {
    const o = oldMask(text); const n = T.maskSecrets(text);
    let any = false;
    for (const sec of secrets) {
      if (o.includes(sec)) continue; // 옛 규칙도 못 가리던 것은 대조 대상이 아니다
      any = true;
      assert.ok(!n.includes(sec), `새 규칙이 놓친다: ${JSON.stringify(text.slice(0, 60))} → ${JSON.stringify(n.slice(0, 90))}`);
    }
    if (any) covered += 1;
  }
  assert.ok(covered >= 20, `옛 규칙이 가리던 칸 ${covered}개 — 대조가 비지 않았다`);
});

test('경계 노출 대조 — 상한 가림 결과에 전체 가림 뒤 자르기보다 많은 원문 비밀이 나오지 않는다(앞 PEM이 줄어 당겨지는 경우·창 안에서 안 닫힌 따옴표 포함)', () => {
  const secrets = [`${'abcdef0123456789'.repeat(2)}.ABCDEFGHijklmnop`, `ghp_${'c'.repeat(36)}`, 'FakePassw0rdXYZ', 'P'.repeat(600), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', 'hunter2fake'];
  const shapes = [
    (sec) => ` ${sec} tail`,
    (sec) => ` "password": "${sec}" end`,
    (sec) => ` postgresql+asyncpg://admin:${sec}@db/x`,
    (sec) => ` --password "${sec}"`,
    (sec) => ` --password "fake words ${sec}\nsecond line of the quoted value"`, // 따옴표 CLI 값이 줄을 넘는다 — 창 끝을 닫는 자리로 봐야 한다
    (sec) => ` Authorization: Bearer ${sec}`,
  ];
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'Q'.repeat(1500)}\n-----END RSA PRIVATE KEY-----\n`;
  let checked = 0;
  for (const LIM of [2000, 4000]) {
    for (const sec of secrets) {
      for (const shape of shapes) {
        for (const lead of ['', pem]) {
          for (const back of [-200, -40, -10, -1, 0, 5, 30, 120, 300]) {
            for (const after of ['', '\nnext line\nmore', '\n']) {
              const body = shape(sec);
              const pad = Math.max(0, LIM - back - lead.length);
              const text = `${lead}${'y'.repeat(pad)}${body}${after}`;
              const cap = T.maskSecrets(text, LIM);
              const full = T.maskSecrets(text).slice(0, LIM);
              assert.ok(cap.length <= LIM);
              for (const k of [6, 12, 24]) {
                const frag = sec.slice(0, k);
                assert.ok(!cap.includes(frag) || full.includes(frag), `노출: LIM=${LIM} back=${back} lead=${!!lead} ${JSON.stringify(body.slice(0, 30))} after=${JSON.stringify(after)} → ${JSON.stringify(cap.slice(-50))}`);
              }
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `대조 칸 ${checked}`);
});
