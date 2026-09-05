// M-ENC-1 E1a 회귀 테스트 — 암호화 대상 예측자·롤아웃 스위치·관용 개봉 불변식.
// 2026-09-06부터 스위치는 기본 켜짐(옵트아웃만 꺼짐) — 봉투 왕복·관용 개봉·키 미확보 보류가 최우선 불변식이다.
// 랜덤 IV로 암호문이 매번 달라진다는 사실도 못 박는다 — 매니페스트 해시가 평문 기준이어야 하는 이유.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretRel, isEncRel, encVaultOn, sealSecret, openSecretCompat, cryptoOn } from '../src/secretbox.mjs';
import { ensureAccountKey, clearAccountKey } from '../src/accountkey.mjs';
import { EXCLUDE } from '../src/sync.mjs';

const withFlag = async (val, fn) => {
  const prev = process.env.ARGO_ENC_VAULT;
  if (val === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = val;
  try { await fn(); } finally { if (prev === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = prev; }
};
// account_keys 조회를 흉내 — v2 봉투 키(계정 키) 확보용
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });

test('스위치 기본 켜짐 — 환경변수 없이도 동기 대상 전체가 암호화 대상(2026-09-06 유건 승인)', async () => {
  await withFlag(undefined, () => {
    assert.equal(encVaultOn(), true, '기본값 = 켜짐');
    assert.equal(encVaultOn({}), true);
    assert.equal(isEncRel('vault/notes/기억.md'), true);
    assert.equal(isEncRel('chats/sales.json'), true);
    assert.equal(isEncRel('usage.jsonl'), true);
    assert.equal(isEncRel('connections.json'), true);
  });
  // '1'·'true'·'on'·빈 문자열·공백은 켜짐, 옵트아웃 4종만 꺼짐(대소문자·공백 무관)
  for (const v of ['1', 'true', 'on', '', '  ']) assert.equal(encVaultOn({ ARGO_ENC_VAULT: v }), true, `값 ${JSON.stringify(v)} = 켜짐`);
  for (const v of ['0', 'false', 'off', 'none', 'OFF', ' False ']) assert.equal(encVaultOn({ ARGO_ENC_VAULT: v }), false, `값 ${JSON.stringify(v)} = 옵트아웃`);
});

test('명시 옵트아웃(ARGO_ENC_VAULT=0) — 암호화 대상은 크레덴셜 3종뿐(종전 동작)', async () => {
  await withFlag('0', () => {
    assert.equal(encVaultOn(), false);
    assert.equal(isEncRel('connections.json'), true);
    assert.equal(isEncRel('.secrets.json'), true);
    assert.equal(isEncRel('mcp.json'), true);
    assert.equal(isEncRel('vault/notes/기억.md'), false, '옵트아웃이면 vault는 평문 — 종전 동작');
    assert.equal(isEncRel('chats/sales.json'), false);
    assert.equal(isEncRel('usage.jsonl'), false);
  });
});

test('스위치 on(명시 1) — 동기 대상 전체가 암호화 대상(회사 폴더 전부)', async () => {
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

// ⚠ 검수 CRITICAL 회귀 방지(2026-07-23): 이전 구현은 EXCLUDE 첫 줄에서 암호화 대상을 먼저 판정해,
// 스위치 ON + 계정키 보유 시 isEncRel이 모든 rel에 true → 조기 반환으로 **구조적 제외 규칙 전체가 우회**됐다.
// 그 결과 .sync-state.json(다른 기기 base가 로컬 base를 덮어써 삭제 오판)·.gw-queue-*(지시 이중 실행)까지
// 동기화 대상이 됐다. 아래 테스트가 그 순서 불변식을 잠근다. (기존 테스트는 플래그 off만 봐서 못 잡았다)
test('스위치 on + 계정키 보유 — 구조적 제외 규칙이 여전히 우선한다', async () => {
  clearAccountKey();
  await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-exclude-test');
  assert.equal(cryptoOn(), true, '전제: 계정 키 보유');
  try {
    await withFlag('1', () => {
      for (const rel of [
        '.gw-queue-telegram/12345.json', // 디스크 큐 안의 파일 — 이중 실행 방지
        '.sync-state.json',              // 로컬 base — 덮어쓰면 삭제 오판
        '.gw-offset-telegram.json', '.gateway-slack.json', // 기기별 폴러 상태
        'chats/luca.status.json',        // 전이 상태
        '.tmp-abc',                      // 원자쓰기 임시본
        'vault/notes/a.md.corrupt-123',  // 손상 백업
        '.sync-process.lock', '.device-id', '.device-session.json', '.sync-credentials.json',
      ]) assert.equal(EXCLUDE(rel), true, `${rel} 은 스위치 on에서도 반드시 제외돼야 한다`);
      // 반대로 실제 회사 콘텐츠는 동기화 대상이어야 한다(암호문으로 나간다)
      assert.equal(EXCLUDE('vault/notes/기억.md'), false);
      assert.equal(EXCLUDE('chats/sales.json'), false);
      assert.equal(EXCLUDE('agents/pepper.md'), false);
    });
  } finally { clearAccountKey(); }
});

test('스위치 on + 계정키 미확보 — 암호화 대상은 전부 제외(삭제 오인 차단)', async () => {
  clearAccountKey(); // 키 없음
  assert.equal(cryptoOn(), false);
  await withFlag('1', () => {
    assert.equal(EXCLUDE('vault/notes/기억.md'), true, '키 없으면 불가시 — 삭제로 오인하면 안 된다');
    assert.equal(EXCLUDE('connections.json'), true);
  });
});
