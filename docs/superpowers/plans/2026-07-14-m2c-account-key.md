# M-2c 계정 키 — 크레덴셜 암호화 키 교체 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로그인-연동(세션 모드) 기기도 크레덴셜(봇 토큰·러너 키)을 안전하게 동기화받는다 — 봉투 암호화 키를 서비스 키 파생에서 **계정별 랜덤 키**로 교체.

**Architecture:** 계정마다 32바이트 랜덤 키를 `account_keys` 테이블(RLS: 본인 행만 select/insert)에 1회 생성·보관. 동기화 사이클이 시작할 때 현재 클라이언트(서비스 or 세션)로 키를 get-or-create해 모듈 캐시에 적재 — `secretbox`는 동기 함수 그대로 캐시를 읽는다. 봉투 포맷은 `argosecret.v2:`로 버전업(계정 키에서 HKDF 파생), v1(서비스 키 파생) 봉투는 **열기 전용 레거시**로 유지해 기존 클라우드 암호문과 호환.

**Tech Stack:** Supabase Postgres(테이블+RLS), supabase-js(.from 쿼리 — 세션 클라이언트는 RLS 자동 스코프), node:crypto, node:test.

**작업 디렉토리: `/Users/yoogeon/lean-projects/_worktrees/argo-m2c`** (워크트리 — 메인 체크아웃은 실서비스 사용 중, 금지). 브랜치 `feat/m2c-account-key`.

## Global Constraints

- 시크릿(키 값·DB 비밀번호) 평문 로그·문서·커밋 금지. `.env.local` 값 echo 금지
- **회귀 0**: 서비스 모드의 기존 v1 봉투는 계속 열려야 한다(레거시 open). 계정 키 확보 실패 시 크레덴셜만 동기화 제외(기존 EXCLUDE 경로)이고 나머지 동기화는 정상
- `sealSecret`/`openSecret`/`cryptoOn`/`isSecretRel`의 **동기 시그니처 불변** (sync.mjs 소비 방식 유지) — 비동기는 사이클 시작의 `ensureAccountKey`가 전담
- 커밋 prefix, 명시 add, macOS sed -i 금지
- 검증: `npm test`, `node --check`, `npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error"`
- DB 적용: `scripts/db-apply.sh <sql>` (M-2에서 검증된 풀러 경로)

---

### Task 1: `account_keys` 테이블 + RLS 마이그레이션

**Files:**
- Create: `supabase/migrations/20260714120000_account_keys.sql`

**Interfaces:**
- Produces: 테이블 `account_keys(user_id, key_b64)` — 본인 행만 select/insert (Task 2가 의존)

- [ ] **Step 1: SQL 작성**:

```sql
-- 계정 키 — 크레덴셜 봉투 암호화(v2)의 계정별 루트 키. 본인만 읽고 1회 생성(갱신·삭제 정책 없음 — 회전은 후속).
-- 서비스 롤은 RLS 우회(워커·셀프호스트가 테넌트 키를 읽는 경로).
create table if not exists public.account_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  key_b64 text not null,
  created_at timestamptz not null default now()
);
alter table public.account_keys enable row level security;

drop policy if exists account_keys_own_select on public.account_keys;
create policy account_keys_own_select on public.account_keys
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists account_keys_own_insert on public.account_keys;
create policy account_keys_own_insert on public.account_keys
  for insert to authenticated with check (user_id = (select auth.uid()));
```

- [ ] **Step 2: 적용 + 검증**

Run: `scripts/db-apply.sh supabase/migrations/20260714120000_account_keys.sql`
Expected: CREATE TABLE / ALTER TABLE / CREATE POLICY×2, 에러 0

Run(검증): psql로 `select policyname from pg_policies where tablename='account_keys' order by 1;` (db-apply.sh와 동일 접속 방식 인라인)
Expected: 정책 2개

- [ ] **Step 3: 커밋**

```bash
git add supabase/migrations/20260714120000_account_keys.sql
git commit -m "feat(m2c): account_keys 테이블 — 계정별 봉투 키, 본인 행만 RLS"
```

---

### Task 2: 계정 키 모듈 — `src/accountkey.mjs`

**Files:**
- Create: `src/accountkey.mjs`
- Test: `test/core.test.mjs`

**Interfaces:**
- Consumes: supabase 클라이언트(호출자가 주입 — sync.mjs의 서비스/세션 클라이언트 겸용), `randomBytes`
- Produces: `ensureAccountKey(sb, ownerId) → Promise<Buffer|null>` (get-or-create + 캐시), `accountKey() → Buffer|null` (동기 캐시 접근 — secretbox용), `clearAccountKey()` — Task 3이 사용

- [ ] **Step 1: 실패하는 테스트** — `test/core.test.mjs`에 추가 (fake supabase 클라이언트로 네트워크 없이):

```js
import { ensureAccountKey, accountKey, clearAccountKey } from '../src/accountkey.mjs';

// fake supabase — from('account_keys') 체인 최소 구현
function fakeSb(store) {
  return {
    from: () => ({
      select: () => ({ eq: (_c, uid) => ({ maybeSingle: async () => ({ data: store.get(uid) ? { key_b64: store.get(uid) } : null, error: null }) }) }),
      insert: async (row) => {
        if (store.has(row.user_id)) return { error: { code: '23505', message: 'duplicate key' } };
        store.set(row.user_id, row.key_b64);
        return { error: null };
      },
    }),
  };
}

test('계정 키 — 생성·재사용·경합·캐시', async () => {
  clearAccountKey();
  const store = new Map();
  // 최초: 생성 + 캐시
  const k1 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k1.length, 32);
  assert.equal(accountKey().equals(k1), true);
  assert.equal(store.size, 1);
  // 재호출: 캐시 (store 접근 불필요 — 같은 버퍼)
  const k2 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k2.equals(k1), true);
  // 다른 기기 시뮬레이션: 캐시 비우고 다시 — 기존 행 재사용(새 키 생성 아님)
  clearAccountKey();
  const k3 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k3.equals(k1), true);
  // 삽입 경합: 빈 캐시 + select는 null이지만 insert가 23505 → 재조회로 승자 키 채택
  clearAccountKey();
  let first = true;
  const racing = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => {
        if (first) { first = false; return { data: null, error: null }; } // 첫 조회는 비어 보임
        return { data: { key_b64: store.get('u-1') }, error: null };      // 재조회는 승자 키
      } }) }),
      insert: async () => ({ error: { code: '23505', message: 'duplicate key' } }),
    }),
  };
  const k4 = await ensureAccountKey(racing, 'u-1');
  assert.equal(k4.equals(k1), true);
  // 오너 없음 → null, 캐시 없음
  clearAccountKey();
  assert.equal(await ensureAccountKey(fakeSb(store), null), null);
  assert.equal(accountKey(), null);
});
```

- [ ] **Step 2: 실패 확인** — `npm test 2>&1 | tail -6` → FAIL (module not found)

- [ ] **Step 3: 구현** — `src/accountkey.mjs`:

```js
// 계정 키 — 크레덴셜 봉투(v2)의 계정별 루트 키. account_keys 테이블에서 get-or-create.
// 호출자는 sync 사이클: 자신의 supabase 클라이언트(서비스 롤 or 세션 JWT+RLS)를 주입한다.
// secretbox는 동기 함수라 여기 캐시를 읽는다 — 키 확보 전에는 cryptoOn()이 false로 떨어져
// 크레덴셜만 동기화에서 빠지고(기존 EXCLUDE 경로), 다음 사이클에 자연 회복된다.
import { randomBytes } from 'node:crypto';

let cached = null;   // Buffer | null
let cachedOwner = '';

/** 동기 캐시 접근 — secretbox 전용. */
export const accountKey = () => cached;

export function clearAccountKey() {
  cached = null;
  cachedOwner = '';
}

async function fetchKey(sb, ownerId) {
  const { data, error } = await sb.from('account_keys').select('key_b64').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(`계정 키 조회 실패: ${error.message}`);
  return data?.key_b64 ?? null;
}

/** get-or-create + 캐시. 실패는 throw하지 않고 null(호출자는 warn 후 진행 — 크레덴셜만 이번 사이클 제외). */
export async function ensureAccountKey(sb, ownerId) {
  if (!ownerId) { return null; }
  if (cached && cachedOwner === ownerId) return cached;
  try {
    let b64 = await fetchKey(sb, ownerId);
    if (!b64) {
      const fresh = randomBytes(32).toString('base64');
      const { error } = await sb.from('account_keys').insert({ user_id: ownerId, key_b64: fresh });
      if (!error) b64 = fresh;
      else if (error.code === '23505') b64 = await fetchKey(sb, ownerId); // 경합 — 승자 키 채택
      else throw new Error(`계정 키 생성 실패: ${error.message}`);
    }
    if (!b64) return null;
    cached = Buffer.from(b64, 'base64');
    cachedOwner = ownerId;
    return cached;
  } catch (e) {
    console.warn('[argo] 계정 키 확보 실패 — 이번 사이클 크레덴셜 동기화 제외:', e.message);
    return null;
  }
}
```

- [ ] **Step 4: 통과 확인** — `npm test 2>&1 | grep -E "^# (pass|fail)"` → fail 0

- [ ] **Step 5: 커밋**

```bash
git add src/accountkey.mjs test/core.test.mjs
git commit -m "feat(m2c): 계정 키 get-or-create — 경합 안전, 동기 캐시"
```

---

### Task 3: secretbox v2 + sync 사이클 연결

**Files:**
- Modify: `src/secretbox.mjs` (v2 봉투 = 계정 키 파생, v1은 열기 전용 레거시, cryptoOn 재정의)
- Modify: `src/sync.mjs` (cycle 시작에서 ensureAccountKey, EXCLUDE에 계정 키 의존 주석)

**Interfaces:**
- Consumes: Task 2 `accountKey()`/`ensureAccountKey`
- Produces: `sealSecret` = 항상 v2, `openSecret` = v2/v1 디스패치, `cryptoOn()` = 계정 키 보유 여부. 시그니처 전부 불변

- [ ] **Step 1: 실패하는 테스트** — `test/core.test.mjs`에 추가:

```js
test('봉투 v2 — 계정 키 왕복, v1 레거시 열기, 위변조 거부', async () => {
  // v2 왕복: 계정 키 캐시를 fake로 채움
  clearAccountKey();
  const store2 = new Map();
  await ensureAccountKey(fakeSb(store2), 'u-crypt');
  assert.equal(cryptoOn(), true);
  const sealed = sealSecret(Buffer.from('{"bot":"tok"}'));
  assert.equal(sealed.subarray(0, 14).toString(), 'argosecret.v2:');
  assert.equal(openSecret(sealed).toString(), '{"bot":"tok"}');
  // 위변조 거부
  const bad = Buffer.from(sealed); bad[bad.length - 1] ^= 0xff;
  assert.throws(() => openSecret(bad));
  // v1 레거시 열기: 서비스 키 HKDF로 v1 봉투를 수제 조립 → openSecret이 해독
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-legacy-service-key';
  const lk = Buffer.from(hkdfSync('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY, 'argo-secret-sync-v1', 'secretbox', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', lk, iv);
  const ct = Buffer.concat([c.update(Buffer.from('legacy-secret')), c.final()]);
  const v1 = Buffer.concat([Buffer.from('argosecret.v1:'), iv, c.getAuthTag(), ct]);
  assert.equal(openSecret(v1).toString(), 'legacy-secret');
  // 계정 키 없으면 cryptoOn false + seal throw
  clearAccountKey();
  assert.equal(cryptoOn(), false);
  assert.throws(() => sealSecret(Buffer.from('x')));
});
```
(`hkdfSync`/`createCipheriv`/`randomBytes` import는 테스트 파일 상단에서 node:crypto — 기존 import 확인 후 추가. 주의: 이 테스트는 env를 세팅하므로 기존 secretbox v1 왕복 테스트와의 순서 간섭을 확인하라 — 기존 테스트가 v1 `sealSecret`을 쓰고 있었다면 이제 v2가 나오므로 **기존 테스트의 기대를 v2로 갱신**하는 것까지가 이 태스크 범위다.)

- [ ] **Step 2: secretbox.mjs 수정** — 전체 구조:

```js
// 시크릿 봉투 암호화 — 동기화로 흐르는 크레덴셜(봇 토큰·러너 키)은 스토리지에 항상 암호문으로만.
// v2(현행): 계정 키(account_keys, 본인 행만 RLS)에서 HKDF 파생 — 로그인-연동 기기도 열 수 있다.
// v1(레거시, 열기 전용): 서비스 키 HKDF — 기존 클라우드 암호문 호환. 크레덴셜이 변경되면 v2로 재봉인된다.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { loadSyncCreds } from './synccreds.mjs';
import { accountKey } from './accountkey.mjs';

const MAGIC2 = Buffer.from('argosecret.v2:');
const MAGIC1 = Buffer.from('argosecret.v1:');
const IV_LEN = 12;
const TAG_LEN = 16;

/** 봉투 가능 여부 = 계정 키 보유 (sync 사이클이 ensureAccountKey로 채운다). */
export const cryptoOn = () => !!accountKey();

// v2 키 — 계정 키에서 파생(도메인 분리). 계정 키 버퍼가 바뀌면 재파생.
let k2 = null, k2src = null;
function key2() {
  const ak = accountKey();
  if (!ak) throw new Error('시크릿 암호화 키 없음 (계정 키 미확보)');
  if (!k2 || k2src !== ak) {
    k2 = Buffer.from(hkdfSync('sha256', ak, 'argo-secret-sync-v2', 'secretbox', 32));
    k2src = ak;
  }
  return k2;
}

// v1 레거시 키 — 서비스 키 HKDF (열기 전용)
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || loadSyncCreds()?.key || null;
let k1 = null, k1src = null;
function key1() {
  const sk = serviceKey();
  if (!sk) throw new Error('레거시 봉투(v1) — 서비스 키 없는 기기에서는 열 수 없습니다');
  if (!k1 || k1src !== sk) {
    k1 = Buffer.from(hkdfSync('sha256', sk, 'argo-secret-sync-v1', 'secretbox', 32));
    k1src = sk;
  }
  return k1;
}

/** 동기화에서 봉투 대상 파일 — 회사 폴더의 크레덴셜 저장소 2종. */
export const isSecretRel = (rel) => rel === 'connections.json' || rel === '.secrets.json';

/** 평문 → v2 봉투(MAGIC ∥ iv ∥ tag ∥ ct). */
export function sealSecret(buf) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key2(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC2, iv, c.getAuthTag(), ct]);
}

/** 봉투 → 평문 (v2/v1 디스패치). 위변조·형식 불일치는 throw — 조용히 깨진 평문을 쓰지 않는다. */
export function openSecret(buf) {
  const k = buf.subarray(0, MAGIC2.length).equals(MAGIC2) ? key2()
    : buf.subarray(0, MAGIC1.length).equals(MAGIC1) ? key1()
    : null;
  if (!k) throw new Error('시크릿 봉투 형식 아님');
  const off = MAGIC2.length; // v1/v2 MAGIC 길이 동일
  const iv = buf.subarray(off, off + IV_LEN);
  const tag = buf.subarray(off + IV_LEN, off + IV_LEN + TAG_LEN);
  const ct = buf.subarray(off + IV_LEN + TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
```
(`credsEpoch` import는 더 이상 불필요 — 제거. 기존 v1 왕복 테스트가 있으면 v2 기대로 갱신.)

- [ ] **Step 3: sync.mjs 연결** — import에 `import { ensureAccountKey } from './accountkey.mjs';` 추가. `cycle()`에서 `ensureClient` 게이트 통과 직후:

```js
  // 계정 키 확보 — 크레덴셜 봉투(v2)의 열쇠. 실패해도 사이클은 계속(크레덴셜만 이번 사이클 제외).
  const keyOwner = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
  await ensureAccountKey(client(), keyOwner);
```
주의: 서비스 셀프호스트에서 `keyOwner`가 null일 수 있다(ARGO_SYNC_OWNER 미설정 + env 자격에 owner 없음) — 그 경우 로컬 회사 스캔 후 `owners[0]`으로 한 번 더 시도: `if (!keyOwner && owners[0]) await ensureAccountKey(client(), owners[0]);` (owners 계산 지점 뒤에).

- [ ] **Step 4: 검증**

Run: `node --check src/secretbox.mjs && node --check src/sync.mjs && node --check src/accountkey.mjs && npm test 2>&1 | grep -E "^# (pass|fail)" && npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3`
Expected: 전부 통과 (기존 secretbox 테스트를 v2 기대로 갱신했으므로 fail 0)

- [ ] **Step 5: 커밋**

```bash
git add src/secretbox.mjs src/sync.mjs test/core.test.mjs
git commit -m "feat(m2c): 봉투 v2 — 계정 키 파생, v1 레거시 열기 전용, 사이클 키 확보"
```

---

### Task 4: E2E + 문서 [컨트롤러 직접 수행]

판정 기준:
1. 세션 모드 기기 A(테스트 계정, 서비스 키 없음)에 `connections.json` 시드(가짜 봇 토큰) → 클라우드 오브젝트가 **`argosecret.v2:` 접두 + 평문 부재** (서비스 키로 바이트 실측)
2. 세션 모드 기기 B(같은 계정) → `connections.json` 도착 + **평문 일치** (계정 키만으로 해독됨)
3. 서비스 모드 인스턴스(같은 계정 ARGO_SYNC_OWNER) → 같은 파일 수신·평문 일치 (모드 간 상호운용)
4. account_keys 행이 계정당 1개(두 기기가 같은 키 재사용 — DB 실측)
5. 다른 계정 세션으로 account_keys 조회 → 본인 행만 (RLS)
6. 회귀: 전체 unit 테스트 + 빌드
7. 정리: 테스트 계정·스토리지·account_keys 행·로컬 root 삭제
8. 문서: PRODUCT-SPEC 빌드 순서 M-2c 완료 표시(취소선), README 기기 추가 절에 "봇 토큰·AI 키까지 따라온다" 1줄. 계획서의 "세션 모드는 크레덴셜 동기화 제외" 한계 문구 해소 반영

## 알려진 한계 (후속)

- 기존 클라우드의 v1 봉투는 크레덴셜 **변경 시** v2로 재봉인 (능동 재봉인 마이그레이션 없음 — 서비스 키 보유 인스턴스는 계속 열 수 있어 실사용 무해)
- 계정 키는 서버(Argo) 신뢰 모델 — 진짜 E2E(사용자 보유 키)는 M-3
- 키 회전 정책 없음 (후속)
