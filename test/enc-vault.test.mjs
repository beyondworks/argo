// M-ENC-1 E1a 회귀 테스트 — 암호화 대상 예측자·롤아웃 스위치·관용 개봉 불변식.
// E1a는 스위치 off가 기본이라 "동작 불변"이 최우선 불변식이고, 켰을 때 봉투 왕복이 성립해야 한다.
// 랜덤 IV로 암호문이 매번 달라진다는 사실도 못 박는다 — 매니페스트 해시가 평문 기준이어야 하는 이유.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretRel, isEncRel, encVaultOn, sealSecret, openSecretCompat, cryptoOn } from '../src/secretbox.mjs';
import { ensureAccountKey, clearAccountKey } from '../src/accountkey.mjs';

const withFlag = async (val, fn) => {
  const prev = process.env.ARGO_ENC_VAULT;
  if (val === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = val;
  try { await fn(); } finally { if (prev === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = prev; }
};
// account_keys 조회를 흉내 — v2 봉투 키(계정 키) 확보용
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });

test('스위치 off(기본) — 암호화 대상은 크레덴셜 3종뿐(기존 동작 불변)', async () => {
  await withFlag(undefined, () => {
    assert.equal(encVaultOn(), false);
    assert.equal(isEncRel('connections.json'), true);
    assert.equal(isEncRel('.secrets.json'), true);
    assert.equal(isEncRel('mcp.json'), true);
    assert.equal(isEncRel('vault/notes/기억.md'), false, 'off면 vault는 평문 — 기존 동작 유지');
    assert.equal(isEncRel('chats/sales.json'), false);
    assert.equal(isEncRel('usage.jsonl'), false);
  });
});

test('스위치 on — 동기 대상 전체가 암호화 대상(회사 폴더 전부)', async () => {
  await withFlag('1', () => {
    assert.equal(encVaultOn(), true);
    assert.equal(isEncRel('vault/notes/기억.md'), true);
    assert.equal(isEncRel('vault/journal/2026-07-23-pepper.md'), true);
    assert.equal(isEncRel('chats/sales.json'), true);
    assert.equal(isEncRel('usage.jsonl'), true);
    assert.equal(isEncRel('agents/pepper.md'), true);
    // 0600 모드용 예측자는 넓히지 않는다 — 파일 모드와 암호화는 별개 관심사
    assert.equal(isSecretRel('vault/notes/기억.md'), false);
  });
});

test('봉투 왕복 — seal → 관용 개봉으로 평문 복원, 암호문은 매번 다름(해시가 평문 기준이어야 하는 이유)', async () => {
  clearAccountKey();
  await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 7).toString('base64')), 'owner-enc-test');
  assert.equal(cryptoOn(), true, '계정 키 확보 → 봉투 가능');
  try {
    const plain = Buffer.from('폴더째 기억 — 10년치 맥락', 'utf8');
    const sealed = sealSecret(plain);
    assert.equal(sealed.toString('utf8', 0, 14), 'argosecret.v2:', 'v2 봉투 매직');
    assert.notDeepEqual(sealed, plain, '평문이 그대로 나가지 않는다');
    assert.deepEqual(openSecretCompat(sealed), plain, '관용 개봉으로 평문 복원');
    assert.notDeepEqual(sealSecret(plain), sealed, '랜덤 IV — 같은 평문도 암호문은 매번 다름');
  } finally { clearAccountKey(); }
});

test('관용 개봉 — 봉투 아닌 기존 평문은 그대로 통과(전환기 무중단)', () => {
  const plain = Buffer.from('예전에 평문으로 올라간 노트');
  assert.deepEqual(openSecretCompat(plain), plain);
});
