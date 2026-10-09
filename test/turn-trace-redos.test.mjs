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

test('상한 경계 — 저장 상한 바로 앞에서 시작해 상한을 넘어가는 비밀도 가려진다(먼저 상한+여유로 자르고 가린 뒤 다시 자른다)', () => {
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
