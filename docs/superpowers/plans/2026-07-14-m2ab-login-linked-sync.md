# M-2a/b "로그인 = 연동" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 기기에서 로그인(이메일 6자리 코드/OAuth)만 하면 회사가 자동으로 내려온다 — 서비스 키가 사용자 기기·연결 코드에서 사라지고, 스토리지는 소유자 RLS로 잠긴다.

**Architecture:** ① companies 버킷에 소유자 RLS(경로 1세그먼트 = auth.uid) 도입. ② "기기 = 로그인 단위" — Supabase Auth 세션을 기기 파일(`.device-session.json`, 0600)에 보관하고 동기화 엔진이 스스로 회전(단일 소유자 원칙 — 브라우저와 refresh 토큰 공유 금지, 회전 충돌 차단). ③ sync 엔진은 듀얼 모드: 서비스 모드(env 서비스 키 — 셀프호스트·Fly 워커, 기존 동작 그대로) / 세션 모드(user JWT + RLS). ④ 로그인 배선: OTP 검증을 서버 라우트가 수행해 세션이 브라우저에 남지 않게 한다.

**Tech Stack:** Supabase Auth(기존 완성) + Storage RLS(SQL 신규), @supabase/supabase-js bare client, node:test.

**작업 디렉토리: `/Users/yoogeon/lean-projects/_worktrees/argo-m2`** (워크트리 — 메인 체크아웃은 실서비스가 사용 중, 절대 건드리지 않는다). 브랜치 `feat/m2-hosted-sync`.

## Global Constraints

- 모든 UI 문자열은 `app/i18n.jsx` 사전(DICT) ko/en 쌍 — 하드코딩 금지
- 시크릿(서비스 키·토큰·DB 비밀번호) 평문을 로그·문서·커밋 메시지에 남기지 않는다. `.env.local` 값 echo 금지
- **회귀 0 3종**: (a) env 서비스 키 셀프호스트 동기화 (b) 로컬 무인증 모드 (c) 클라우드 워커(쿠키 인증 + ARGO_TENANT_OWNER) — 기기 세션은 이 셋을 건드리지 않는 4번째 모드
- 커밋 prefix 규약, 파일 명시적 add. macOS — `sed -i` 금지
- 검증: `npm test`, `node --check`, `npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error"`
- DB 적용: psql 풀러 경유 — host `aws-1-ap-northeast-2.pooler.supabase.com`, user `postgres.<ref>`, 비밀번호는 `.env.local`의 `SUPABASE_DB_PASSWORD`에서 스크립트가 읽는다 (평문 출력 금지)

---

### Task 1: Storage RLS 마이그레이션 + 적용

**Files:**
- Create: `supabase/migrations/20260714090000_companies_storage_rls.sql`
- Create: `scripts/db-apply.sh`

**Interfaces:**
- Consumes: 버킷 경로 규약 `companies/<ownerId>/<wsId>/...` (`src/sync.mjs` `skey`)
- Produces: authenticated 사용자가 자기 uid 폴더만 CRUD 가능한 정책 4개 (Task 3의 세션 모드, Task 6의 RLS 음성 테스트가 의존)

- [ ] **Step 1: 마이그레이션 SQL 작성** — `supabase/migrations/20260714090000_companies_storage_rls.sql`:

```sql
-- companies 버킷 — 소유자(auth.uid) 폴더만 CRUD. 서비스 롤은 RLS를 우회한다(Fly 워커·셀프호스트 전용).
-- 경로 규약: companies/<ownerId>/<wsId>/... (src/sync.mjs skey) — 1세그먼트가 곧 테넌트 경계.
-- 멱등: drop if exists 후 create.
drop policy if exists companies_owner_select on storage.objects;
create policy companies_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_delete on storage.objects;
create policy companies_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));
```

- [ ] **Step 2: 적용 스크립트** — `scripts/db-apply.sh` (실행 권한 부여):

```bash
#!/usr/bin/env bash
# Supabase DB에 마이그레이션 적용 — 풀러 경유(직결 DNS 없는 신형 프로젝트).
# 사용: scripts/db-apply.sh supabase/migrations/<file>.sql
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?사용법: db-apply.sh <sql파일>}"
REF=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | sed -E 's|.*//([a-z0-9]+)\.supabase\.co.*|\1|')
PW=$(grep SUPABASE_DB_PASSWORD .env.local | cut -d= -f2-)
PGPASSWORD="$PW" psql -h aws-1-ap-northeast-2.pooler.supabase.com -p 5432 \
  -U "postgres.${REF}" -d postgres -v ON_ERROR_STOP=1 -f "$FILE"
```

- [ ] **Step 3: 적용 + 검증**

Run: `chmod +x scripts/db-apply.sh && scripts/db-apply.sh supabase/migrations/20260714090000_companies_storage_rls.sql`
Expected: `CREATE POLICY` × 4 (에러 0)

Run: `REF=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | sed -E 's|.*//([a-z0-9]+)\.supabase\.co.*|\1|'); PGPASSWORD=$(grep SUPABASE_DB_PASSWORD .env.local | cut -d= -f2-) psql -h aws-1-ap-northeast-2.pooler.supabase.com -p 5432 -U "postgres.${REF}" -d postgres -t -c "select policyname from pg_policies where tablename='objects' and policyname like 'companies_owner%' order by 1;"`
Expected: 4개 정책명 출력

- [ ] **Step 4: 커밋**

```bash
git add supabase/migrations/20260714090000_companies_storage_rls.sql scripts/db-apply.sh
git commit -m "feat(m2): companies 버킷 소유자 RLS — auth.uid 폴더만 CRUD"
```

---

### Task 2: 기기 세션 저장소 — `src/devicesession.mjs`

**Files:**
- Create: `src/devicesession.mjs`
- Test: `test/core.test.mjs`

**Interfaces:**
- Consumes: `WS_ROOT`(workspace.mjs), `withLock`(mutex.mjs — `withLock(key, fn)`), `createClient`(supabase-js)
- Produces: `loadDeviceSession({root?}) → sess|null`, `saveDeviceSession({url, anonKey, session}, {root?})`, `clearDeviceSession({root?})`, `getFreshDeviceSession({root?}) → Promise<sess|null>` (만료 60초 전 자체 회전+저장), `deviceEpoch() → number` — Task 3(sync)·Task 4(auth 라우트)가 사용

- [ ] **Step 1: 실패하는 테스트** — `test/core.test.mjs`에 추가 (synccreds 테스트 옆, 같은 tmp 관례):

```js
import { loadDeviceSession, saveDeviceSession, clearDeviceSession, getFreshDeviceSession, deviceEpoch } from '../src/devicesession.mjs';

test('기기 세션 — 저장/로드/삭제, 0600, 손상 안전', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    assert.equal(loadDeviceSession({ root }), null);
    const session = { access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-1', email: 'a@b.c' } };
    const e0 = deviceEpoch();
    await saveDeviceSession({ url: 'https://x.supabase.co', anonKey: 'anon', session }, { root });
    assert.equal(deviceEpoch(), e0 + 1);
    const sess = loadDeviceSession({ root });
    assert.equal(sess.user.id, 'u-1');
    assert.equal(sess.refresh_token, 'rt1');
    const st = await stat(join(root, '.device-session.json'));
    assert.equal(st.mode & 0o777, 0o600);
    // 만료가 먼 세션은 네트워크 없이 그대로 반환
    const fresh = await getFreshDeviceSession({ root });
    assert.equal(fresh.access_token, 'at1');
    // 필수값 누락 거부
    await assert.rejects(() => saveDeviceSession({ url: 'x', anonKey: 'a', session: { access_token: 'q' } }, { root }));
    // 삭제
    await clearDeviceSession({ root });
    assert.equal(loadDeviceSession({ root }), null);
    // 손상 파일 → null (경고는 stderr — 값 미출력)
    await writeFile(join(root, '.device-session.json'), '{broken');
    assert.equal(loadDeviceSession({ root }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
```
(`writeFile`은 node:fs/promises에서 — 기존 import 확인 후 없으면 추가.)

- [ ] **Step 2: 실패 확인** — Run: `npm test 2>&1 | tail -8` / Expected: FAIL `Cannot find module '../src/devicesession.mjs'`

- [ ] **Step 3: 구현** — `src/devicesession.mjs`:

```js
// 기기 세션 — "이 기기 = 이 계정" (M-2 로그인=연동의 심장).
// Supabase Auth 세션(access+refresh)을 기기 파일(0600)에 보관하고, 만료 임박 시 스스로 회전한다.
// 회전 충돌 방지 원칙: 이 파일이 세션의 단일 소유자 — 브라우저 쿠키/클라이언트와 refresh 토큰을
// 공유하지 않는다(공유하면 Supabase 토큰 회전 재사용 감지로 세션 일가족이 폐기된다).
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT } from './workspace.mjs';
import { withLock } from './mutex.mjs';

const FILE = '.device-session.json';
let cache = null; // { root, sess }
let epoch = 0;
export const deviceEpoch = () => epoch;
const fileOf = (root) => join(root, FILE);

/** 기기 세션 또는 null. 파일 손상은 경고(경로만) 후 null — 시크릿 값은 절대 출력하지 않는다. */
export function loadDeviceSession({ root = WS_ROOT } = {}) {
  if (cache && cache.root === root) return cache.sess;
  let sess = null;
  try {
    const d = JSON.parse(readFileSync(fileOf(root), 'utf8'));
    if (d.url && d.anonKey && d.refresh_token && d.access_token && d.user?.id) sess = d;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[argo] 기기 세션 파일 손상 — 재로그인 필요: ${fileOf(root)}`);
  }
  cache = { root, sess };
  return sess;
}

async function persist(sess, root) {
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.tmp-devsess-${process.pid}-${Date.now().toString(36)}`);
  await writeFile(tmp, JSON.stringify(sess, null, 2), { mode: 0o600 }); // 생성 시점부터 0600
  await rename(tmp, fileOf(root)); // 원자 교체 — 모드 보존
  cache = null;
  epoch++;
}

/** 로그인/링크 시 저장. session = Supabase Auth 세션(user 포함). */
export async function saveDeviceSession({ url, anonKey, session }, { root = WS_ROOT } = {}) {
  if (!url || !anonKey || !session?.access_token || !session?.refresh_token || !session?.user?.id) {
    throw new Error('기기 세션 저장에 필요한 값 누락 (url/anonKey/session)');
  }
  await persist({
    url, anonKey,
    user: { id: session.user.id, email: session.user.email ?? '' },
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? 0,
  }, root);
}

export async function clearDeviceSession({ root = WS_ROOT } = {}) {
  await rm(fileOf(root), { force: true });
  cache = null;
  epoch++;
}

/** 유효한 access token 보장 — 만료 60초 전이면 회전 후 저장(락으로 직렬화). null = 세션 없음/회전 실패. */
export async function getFreshDeviceSession({ root = WS_ROOT } = {}) {
  return withLock(`devsess:${root}`, async () => {
    const sess = loadDeviceSession({ root });
    if (!sess) return null;
    if ((sess.expires_at ?? 0) * 1000 - Date.now() > 60_000) return sess;
    const sb = createClient(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.refreshSession({ refresh_token: sess.refresh_token });
    if (error || !data?.session) {
      console.warn('[argo] 기기 세션 갱신 실패 — 재로그인 필요:', error?.message ?? 'no session');
      return null;
    }
    const s = data.session;
    const next = {
      ...sess,
      access_token: s.access_token,
      refresh_token: s.refresh_token, // 회전된 토큰 즉시 영속 — 유실 시 세션 일가족 폐기
      expires_at: s.expires_at ?? 0,
      user: { id: s.user?.id ?? sess.user.id, email: s.user?.email ?? sess.user.email },
    };
    await persist(next, root);
    return next;
  });
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm test 2>&1 | grep -E "^# (pass|fail)"` / Expected: `# fail 0`

- [ ] **Step 5: 커밋**

```bash
git add src/devicesession.mjs test/core.test.mjs
git commit -m "feat(m2): 기기 세션 저장소 — 단일 소유자 회전, 0600 원자 저장"
```

---

### Task 3: sync 엔진 듀얼 모드 — 서비스 키 | 기기 세션(JWT)

**Files:**
- Modify: `src/sync.mjs` (syncOn, 클라이언트, cycle, ensureSync, discoverRemote, EXCLUDE)

**Interfaces:**
- Consumes: Task 2 전부, 기존 `loadSyncCreds`/`credsEpoch`
- Produces: 세션 모드에서 user JWT로 스토리지 접근(RLS 적용), `ensureSync()` 재호출 시 기기 세션이 새로 생겨도 기동 (Task 4 라우트가 의존). 서비스 모드 동작 불변

- [ ] **Step 1: sync.mjs 수정.** import에 `import { loadDeviceSession, getFreshDeviceSession } from './devicesession.mjs';` 추가 후:

`syncOn()` →
```js
// 동기화 스위치 — 서비스 자격(env/페어링 파일) 또는 기기 세션(로그인=연동). 서비스 자격이 우선.
export const syncOn = () => (!!loadSyncCreds() || !!loadDeviceSession()) && process.env.ARGO_SYNC !== '0';
```

클라이언트 블록(현 `let sb = null, sbEpoch = -1; const client = ...`) → 모드 인지 재구성:
```js
const CLIENT_OPTS = {
  auth: { persistSession: false },
  // 타임아웃 필수 — 기본 fetch는 무한 대기라 요청 하나가 걸리면 동기화 전체가 영원히 멈춘다(실측)
  global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) }) },
};
let sb = null, sbKey = '';
// cycle 시작마다 호출 — 서비스 모드는 epoch, 세션 모드는 access token으로 캐시 키를 삼아
// 자격 회전 시에만 클라이언트를 재생성한다. false = 쓸 자격 없음(이번 사이클 스킵).
async function ensureClient() {
  const svc = loadSyncCreds();
  if (svc) {
    const k = `svc:${credsEpoch()}`;
    if (sbKey !== k) { sb = createClient(svc.url, svc.key, CLIENT_OPTS); sbKey = k; }
    return true;
  }
  const sess = await getFreshDeviceSession();
  if (!sess) return false;
  const k = `sess:${sess.access_token.slice(-24)}`;
  if (sbKey !== k) {
    sb = createClient(sess.url, sess.anonKey, {
      ...CLIENT_OPTS,
      global: { ...CLIENT_OPTS.global, headers: { Authorization: `Bearer ${sess.access_token}` } },
    });
    sbKey = k;
  }
  return true;
}
const client = () => sb; // ensureClient() 성공 뒤에만 호출된다 (cycle/ensureSync 게이트)
```

`cycle()` 첫 줄에 추가:
```js
  if (!(await ensureClient())) { status.lastError = '동기화 자격 없음/만료 — 재로그인 필요'; return; }
```

`discoverRemote` 오너 고정 — 기존 `const fixed = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || null;` →
```js
  const fixed = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
```

`ensureSync()` 루프의 `createBucket` — 서비스 모드에서만 (세션 모드는 RLS로 버킷 관리 권한 없음, 호스팅 프로젝트엔 버킷이 이미 존재):
```js
    if (loadSyncCreds()) {
      try { await ensureClient(); await client().storage.createBucket(BUCKET, { public: false }); } catch { /* 이미 있음 */ }
    }
```

`EXCLUDE`에 `base === '.device-session.json' ||` 추가 (`.sync-credentials.json` 옆 — 심층 방어).

- [ ] **Step 2: 검증**

Run: `node --check src/sync.mjs && npm test 2>&1 | grep -E "^# (pass|fail)" && npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3`
Expected: 전부 통과, `# fail 0` (서비스 모드 회귀 없음 — 기존 테스트가 그 증거)

- [ ] **Step 3: 커밋**

```bash
git add src/sync.mjs
git commit -m "feat(m2): sync 듀얼 모드 — 서비스 키 또는 기기 세션(JWT+RLS)"
```

---

### Task 4: 인증 배선 — 기기 로그인/링크 라우트 + currentUser/미들웨어

**Files:**
- Create: `app/api/device/login/route.js` (OTP 검증을 서버가 수행 — 세션이 브라우저에 안 남음)
- Create: `app/api/device/link/route.js` (이미 발급된 세션 토큰 수령 — Tauri 브리지·E2E용)
- Modify: `app/auth.mjs` (currentUser 기기 세션 분기), `middleware.js` (기기 마커 통과 + 공개 경로), `app/auth/callback/route.js` (OAuth 세션을 기기 파일로), `app/auth/signout/route.js` (기기 세션 삭제)

**Interfaces:**
- Consumes: Task 2 (`saveDeviceSession`/`loadDeviceSession`/`clearDeviceSession`), Task 3 (`ensureSync` 재호출)
- Produces: `POST /api/device/login {email, token}` → `{ok, user}`, `POST /api/device/link {access_token, refresh_token}` → `{ok, user}`. 마커 쿠키 `argo-device=1`(httpOnly). currentUser가 기기 세션 사용자를 반환 — 이후 모든 guardCompany가 자동으로 소유자 스코프

**설계 주의 (구현자 필독):**
- **회전 충돌 금지 원칙**: 기기 세션의 refresh 토큰은 기기 파일만 소유한다. 브라우저 supabase 클라이언트에 같은 세션을 setSession 하지 말 것.
- **마커 쿠키는 UX 게이트일 뿐** — 실제 권한은 라우트의 currentUser(기기 파일)가 검증. 로컬 기기(루프백) 신뢰 모델은 기존 로컬 모드와 동일.
- **클라우드 워커 회귀 0**: `ARGO_TENANT_OWNER` 설정 시 두 라우트 모두 403, currentUser는 기기 세션 분기를 건너뛰고 기존 쿠키 경로 유지.

- [ ] **Step 1: 로그인 라우트** — `app/api/device/login/route.js`:

```js
// 기기 로그인 — OTP 검증을 서버가 수행하고 세션을 기기 파일에만 저장한다(브라우저에 세션 없음 —
// refresh 토큰 단일 소유자 원칙). 성공 시 동기화가 재시작 없이 기동된다.
import { createClient } from '@supabase/supabase-js';
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { AUTH_ON } from '../../../auth.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 로그인이 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 기기 로그인을 쓸 수 없습니다' }, { status: 403 });
    const { email, token } = await req.json();
    if (!email?.trim() || !token?.trim()) return Response.json({ error: '이메일과 코드가 필요합니다' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: 'email' });
    if (error || !data?.session) return Response.json({ error: error?.message || '코드가 올바르지 않습니다' }, { status: 401 });
    await saveDeviceSession({ url, anonKey, session: data.session });
    ensureSync(); // 자격이 방금 생겼다 — 재시작 없이 동기화 기동
    return Response.json(
      { ok: true, user: { id: data.session.user.id, email: data.session.user.email ?? '' } },
      { headers: { 'Set-Cookie': marker() } },
    );
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
```

- [ ] **Step 2: 링크 라우트** — `app/api/device/link/route.js` (Tauri 브리지가 회수한 세션·E2E가 사용. 토큰 자체가 인증 증거 — getUser로 검증 후 저장):

```js
// 기기 링크 — 이미 발급된 Supabase 세션(access+refresh)을 검증해 기기 파일로 귀속시킨다.
// 사용처: 앱 브라우저 핸드오프(claim 결과), 헤드리스 E2E. 토큰 검증 실패 = 401.
import { createClient } from '@supabase/supabase-js';
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { AUTH_ON } from '../../../auth.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 링크가 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 기기 링크를 쓸 수 없습니다' }, { status: 403 });
    const { access_token, refresh_token } = await req.json();
    if (!access_token || !refresh_token) return Response.json({ error: '토큰이 필요합니다' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error } = await sb.auth.getUser(access_token); // 토큰 진위 검증
    if (error || !user) return Response.json({ error: '유효하지 않은 세션입니다' }, { status: 401 });
    await saveDeviceSession({ url, anonKey, session: { access_token, refresh_token, expires_at: 0, user } }); // expires 0 = 첫 사용 시 즉시 회전
    ensureSync();
    return Response.json({ ok: true, user: { id: user.id, email: user.email ?? '' } }, { headers: { 'Set-Cookie': marker() } });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: currentUser 기기 세션 분기** — `app/auth.mjs`의 currentUser, `if (!AUTH_ON) return ...` 다음 줄에:

```js
  // 기기 연동 모드 — 이 기기가 계정에 귀속됨(로그인=연동). 워커(TENANT)는 쿠키 경로 유지.
  if (!TENANT) {
    const dev = loadDeviceSession();
    if (dev) return { id: dev.user.id, email: dev.user.email };
  }
```
파일 상단 import에 `import { loadDeviceSession, clearDeviceSession } from '../src/devicesession.mjs';` 추가. (auth.mjs는 이미 src/workspace.mjs를 임포트 — 계층 위반 아님.)

- [ ] **Step 4: 미들웨어** — `middleware.js`:
1. 공개 경로에 device 라우트 추가: `|| p.startsWith('/api/device/')`  (`isPublic` 계산식).
2. supabase 쿠키 검사 **앞에** 기기 마커 통과 분기 (루프백 한정 — 로컬 기기 신뢰 모델):
```js
  // 기기 연동 모드 — 마커 쿠키는 UX 게이트(리다이렉트 회피)일 뿐, 권한은 라우트 currentUser(기기 파일)가 검증.
  // 루프백 한정: 원격에서 마커만 들고 오는 요청은 통과시키지 않는다. 워커(TENANT)는 이 분기 없음.
  if (!process.env.ARGO_TENANT_OWNER && req.cookies.get('argo-device')?.value === '1') {
    const host = req.headers.get('host') || '';
    if (LOCAL_HOST_RE.test(host)) {
      if (req.nextUrl.pathname === '/login') return NextResponse.redirect(publicUrl(req, '/'));
      return NextResponse.next();
    }
  }
```

- [ ] **Step 5: OAuth 콜백 분기** — `app/auth/callback/route.js`: `exchangeCodeForSession` 성공 직후(기존 리다이렉트 전에), 워커가 아니면 세션을 기기 파일로 귀속:
```js
    // 기기 연동 — OAuth 로그인도 기기 파일이 세션의 단일 소유자가 된다(쿠키 세션은 이후 미사용).
    if (!process.env.ARGO_TENANT_OWNER?.trim() && data?.session) {
      await saveDeviceSession({ url: URL_ENV, anonKey: KEY_ENV, session: data.session });
      ensureSync();
      res.headers.append('Set-Cookie', 'argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
    }
```
(실제 변수명·응답 객체는 파일 구조에 맞춰 적용 — exchange 결과 세션 접근이 없으면 `supabase.auth.getSession()`으로 회수. import 2건 추가.)

- [ ] **Step 6: 로그아웃** — `app/auth/signout/route.js`: 기존 처리에 더해 `await clearDeviceSession();` + 마커 쿠키 제거(`Set-Cookie: argo-device=; Path=/; Max-Age=0`).

- [ ] **Step 7: 검증**

Run: `node --check app/api/device/login/route.js && node --check app/api/device/link/route.js && node --check app/auth.mjs && node --check middleware.js && npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3 && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 전부 통과. (middleware는 edge 번들 — `node --check`가 실패하면 build 통과로 갈음하고 리포트에 명시)

- [ ] **Step 8: 커밋**

```bash
git add app/api/device/login/route.js app/api/device/link/route.js app/auth.mjs middleware.js app/auth/callback/route.js app/auth/signout/route.js
git commit -m "feat(m2): 로그인=연동 배선 — 기기 세션 라우트·currentUser·미들웨어"
```

---

### Task 5: UI — 로그인 경유 변경 + 기기/홈 카드 모드 분기 + i18n

**Files:**
- Modify: `app/login/page.jsx` (verifyCode → `/api/device/login` 경유, 앱 브리지 claim → `/api/device/link`)
- Modify: `app/c/[ws]/settings/page.jsx` (DevicesCard — authOn이면 로그인 안내로 전환)
- Modify: `app/page.jsx` (홈 수신 블록 — authOn이면 숨김)
- Modify: `app/i18n.jsx`

**Interfaces:**
- Consumes: Task 4 라우트, `/api/me` → `{authOn, user}` (기존)
- Produces: 없음 (말단 UI)

- [ ] **Step 1: 로그인 페이지** — `app/login/page.jsx`:
- `verifyCode()`의 `supabase.auth.verifyOtp(...)` 호출을 서버 경유로 교체 (세션이 브라우저에 남지 않게):
```js
      const res = await fetch('/api/device/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), token: code.trim() }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      window.location.href = '/';
```
- 앱 브리지(`oauthViaBrowser`)의 `await supabase.auth.setSession(res.session);` →
```js
          const link = await fetch('/api/device/link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: res.session.access_token, refresh_token: res.session.refresh_token }),
          }).then((r) => r.json());
          if (link.error) { setError(String(link.error)); setWaiting(false); return; }
```

- [ ] **Step 2: i18n 키 추가** (ko/en 쌍):
```js
'settings.devices.loginMode': ['이 회사는 계정 동기화로 연결됩니다 — 새 기기에서 Argo를 열고 같은 계정으로 로그인하면 자동으로 내려옵니다. 연결 코드는 셀프호스팅 전용입니다.', 'This company syncs with your account — open Argo on a new device and sign in with the same account; it arrives automatically. Link codes are for self-hosting only.'],
'home.pair.loginMode': ['다른 기기의 회사는 같은 계정으로 로그인하면 자동으로 이어집니다.', 'Companies from your other devices continue automatically when you sign in with the same account.'],
```

- [ ] **Step 3: DevicesCard 분기** — `app/c/[ws]/settings/page.jsx`: DevicesCard에 `authOn` prop 전달(설정 페이지가 이미 `/api/me` 또는 상위 데이터로 판단 가능한 경로 사용 — 없으면 카드 내 `api('/api/me')` 1회 fetch). `authOn === true`면 버튼·코드 대신 `<p>{t('settings.devices.loginMode')}</p>`만 렌더. false면 기존 코드 발급 UI 그대로.

- [ ] **Step 4: 홈 분기** — `app/page.jsx`: 수신 블록 section을 `!authOn`일 때만 렌더 (`api('/api/companies')` 옆에서 `api('/api/me')`로 authOn 확보 — 기존 로드 useEffect에 병렬 추가). authOn이면 대신 한 줄 `<p className="microlabel">{t('home.pair.loginMode')}</p>`.

- [ ] **Step 5: 검증** — Run: `npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3` / Expected: ✓ Compiled. (브라우저 확인은 Task 6 E2E에서 컨트롤러가 수행 — 리포트에 명시)

- [ ] **Step 6: 커밋**

```bash
git add app/login/page.jsx "app/c/[ws]/settings/page.jsx" app/page.jsx app/i18n.jsx
git commit -m "feat(m2): 로그인=연동 UI — OTP 서버 경유, 기기/홈 카드 모드 분기"
```

---

### Task 6: E2E (헤드리스 — admin 세션 발급) + 문서 [컨트롤러 직접 수행]

**Files:**
- Modify: `README.md`, `PRODUCT-SPEC.md` (M-2a/b 반영 1~3줄)

이 태스크는 컨트롤러가 직접 실행한다. 판정 기준:

1. **세션 발급(이메일 불요)**: 서비스 키(env)로 admin `createUser`(테스트 계정 2개, `*@argo-e2e.test`) + `generateLink({type:'magiclink'})` → token_hash를 anon 클라이언트 `verifyOtp({type:'magiclink'})`로 소비 → 세션 확보. 토큰 값 미출력.
2. **기기 A** (워크트리, 포트 3012, env: URL+ANON만 — 서비스 키 없음): `/api/device/link`로 유저1 세션 링크 → 회사 생성(ownerId 자동 = 유저1) → 기억 시드 → 동기화가 **JWT+RLS로** 클라우드에 푸시되는지 (업로드 성공 = RLS 양성).
3. **기기 B** (포트 3013, 별도 root): 유저1의 두 번째 세션 링크 → 회사 자동 수신 + 파일 diff 일치 + 역방향.
4. **RLS 음성**: 유저2 세션의 JWT로 유저1 폴더 list → 빈 결과(차단). 유저2 폴더 접근은 정상.
5. **회귀**: 서비스 모드(기존 env 전체) 인스턴스가 여전히 동기화되는지 1사이클 확인.
6. **UI**: 로그인 화면에서 `/api/device/login` 경로 실동작(admin OTP는 이메일이라 UI는 세션 링크 후 화면 상태로 검증), 설정 기기 카드 authOn 분기 렌더.
7. **정리**: 테스트 유저·스토리지 폴더 admin 삭제, 서버 중지, 임시 root 삭제.
8. **문서**: README "기기 추가" 섹션에 로그인=연동을 1순위로, 연결 코드를 셀프호스팅 백업으로 갱신. PRODUCT-SPEC 빌드 순서에 M-2a/b 완료 표시.

---

## 알려진 한계 (계획 밖 — 후속)

- **세션 모드에서 크레덴셜(봇 토큰·러너 키) 동기화 제외** — secretbox 키가 서비스 키 파생이라 세션 모드엔 키가 없음(`cryptoOn()` false → 기존 EXCLUDE 경로, 회귀 아님). M-2c(계정 키)에서 해소.
- 마커 쿠키 없는 브라우저(다른 브라우저로 접속)는 /login으로 가지만 이미 기기가 연동됨 — 로그인하면 무해(기기 파일 갱신). UX 다듬기는 후속.
- entitlement(Free/Pro 게이트)는 M-2d.
- Tauri 앱 실기기 검증은 데스크톱 패키징 트랙에서.
