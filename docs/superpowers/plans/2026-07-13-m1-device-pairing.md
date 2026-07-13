# M-1 원클릭 기기 페어링 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기기 A에서 연결 코드 하나를 만들어 기기 B에 붙여넣으면, B가 동기화 자격을 저장하고 재시작 없이 회사(기억·크루·대화)를 수신한다.

**Architecture:** 연결 코드는 자가완결 blob(`argo-pair.v1.<base64url(JSON)>`) — 서버 우편함 없이 사용자가 직접 운반한다. 자격의 단일 출처를 새 모듈 `src/synccreds.mjs`(env 우선 → `WS_ROOT/.sync-credentials.json` 폴백)로 승격하고, `sync.mjs`/`secretbox.mjs`가 부팅 시점 env 상수 대신 호출 시점 자격 조회(epoch 캐시)를 쓰도록 배선을 바꾼다. 그래야 페어링 직후 `ensureSync()` 재호출만으로 동기화가 켜진다.

**Tech Stack:** Node 순수 모듈(src/*.mjs), Next.js App Router 라우트(app/api), node:test + assert/strict, 기존 Supabase Storage 동기화 엔진(sync.mjs) 재사용.

## Global Constraints

- 모든 UI 문자열은 `app/i18n.jsx` 사전(`DICT`)에 ko/en 쌍으로 등록 (프로젝트 CLAUDE.md 절대 규칙)
- 시크릿 평문을 로그·문서·커밋 메시지에 남기지 않는다. 연결 코드는 서비스 키를 담으므로 **console.log 금지**
- 기존 자가 호스팅 동작(env로 동기화 켜기) 회귀 0 — env가 있으면 파일보다 항상 우선
- 커밋 prefix: `feat:`/`fix:`/`test:` 규약, 파일 명시적 add (`git add .` 금지)
- macOS 환경 — `sed -i` 금지
- 검증 명령: `npm test` = `node --test test/*.test.mjs`, 문법 체크 = `node --check <file>`

---

### Task 1: 연결 코드 인코더/파서 — `src/pairing.mjs`

**Files:**
- Create: `src/pairing.mjs`
- Test: `test/core.test.mjs` (기존 파일에 test() 추가 — 파일 관례)

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces: `makePairCode({url, key, owner}) → string`, `parsePairCode(code) → {url, key, owner}` (Task 4의 두 라우트가 사용)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/core.test.mjs` 말미에 추가:

```js
import { makePairCode, parsePairCode } from '../src/pairing.mjs';

test('페어링 코드 — 왕복', () => {
  const creds = { url: 'https://example.supabase.co', key: 'service-key-123', owner: 'owner-abc' };
  const code = makePairCode(creds);
  assert.ok(code.startsWith('argo-pair.v1.'));
  assert.deepEqual(parsePairCode(code), creds);
});

test('페어링 코드 — 형식 불일치·필드 누락 거부', () => {
  assert.throws(() => parsePairCode('garbage'));
  assert.throws(() => parsePairCode('argo-pair.v1.' + Buffer.from('{"u":"x"}').toString('base64url'))); // k,o 누락
  assert.throws(() => parsePairCode(''));
  assert.throws(() => makePairCode({ url: 'x', key: '', owner: 'y' })); // 누락 값
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../src/pairing.mjs'`

- [ ] **Step 3: 구현** — `src/pairing.mjs` 생성:

```js
// M-1 기기 페어링 — 연결 코드 하나로 두 번째 기기가 동기화 자격(Supabase URL·서비스 키·오너)을 받는다.
// 코드는 자가완결(서버 우편함 없음): 사용자가 복사→붙여넣기로 직접 운반한다. 비밀번호처럼 다뤄야 함.
// M-2(테넌트 스코프 자격)에서 payload만 교체할 수 있도록 버전 접두사로 봉인.
const PREFIX = 'argo-pair.v1.';

/** 동기화 자격 → 연결 코드. */
export function makePairCode({ url, key, owner }) {
  if (!url || !key || !owner) throw new Error('페어링에 필요한 값 누락 (url/key/owner)');
  return PREFIX + Buffer.from(JSON.stringify({ u: url, k: key, o: owner })).toString('base64url');
}

/** 연결 코드 → 동기화 자격. 형식 불일치·필드 누락은 throw — 조용히 빈 자격을 만들지 않는다. */
export function parsePairCode(code) {
  const s = String(code ?? '').trim();
  if (!s.startsWith(PREFIX)) throw new Error('연결 코드 형식이 아닙니다');
  let obj;
  try { obj = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new Error('연결 코드를 해독할 수 없습니다'); }
  const { u, k, o } = obj ?? {};
  if (!u || !k || !o) throw new Error('연결 코드에 필요한 값이 없습니다');
  return { url: u, key: k, owner: o };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`, pass 카운트 기존 대비 +2

- [ ] **Step 5: 커밋**

```bash
git add src/pairing.mjs test/core.test.mjs
git commit -m "feat(pair): 연결 코드 인코더/파서 — argo-pair.v1 자가완결 blob"
```

---

### Task 2: 동기화 자격 단일 출처 — `src/synccreds.mjs`

**Files:**
- Create: `src/synccreds.mjs`
- Test: `test/core.test.mjs`

**Interfaces:**
- Consumes: `WS_ROOT` (`src/workspace.mjs:7`)
- Produces: `loadSyncCreds({root?, env?}) → {url, key, owner}|null`, `saveSyncCreds({url,key,owner}, {root?}) → Promise<void>`, `credsEpoch() → number` (Task 3의 sync.mjs·secretbox.mjs, Task 4의 라우트가 사용)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/core.test.mjs`에 추가 (기존 tmp 디렉토리 관례: `mkdtemp(join(tmpdir(), 'argo-test-'))`):

```js
import { loadSyncCreds, saveSyncCreds, credsEpoch } from '../src/synccreds.mjs';

test('동기화 자격 — env 우선, 파일 폴백, 저장 후 epoch 증가', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    // env 우선
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://e.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'ek', ARGO_SYNC_OWNER: 'eo' };
    assert.deepEqual(loadSyncCreds({ root, env }), { url: 'https://e.supabase.co', key: 'ek', owner: 'eo' });
    // env 없고 파일 없음 → null
    assert.equal(loadSyncCreds({ root, env: {} }), null);
    // 저장 → 파일 폴백 + epoch 증가 + 0600
    const e0 = credsEpoch();
    await saveSyncCreds({ url: 'https://f.supabase.co', key: 'fk', owner: 'fo' }, { root });
    assert.equal(credsEpoch(), e0 + 1);
    assert.deepEqual(loadSyncCreds({ root, env: {} }), { url: 'https://f.supabase.co', key: 'fk', owner: 'fo' });
    const st = await stat(join(root, '.sync-credentials.json'));
    assert.equal(st.mode & 0o777, 0o600);
    // 누락 값 저장 거부
    await assert.rejects(() => saveSyncCreds({ url: 'x', key: '', owner: 'y' }, { root }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

(`stat`·`rm`·`mkdtemp`·`tmpdir`·`join` import는 기존 테스트 파일 상단에 이미 있는지 확인 후 없는 것만 추가.)

- [ ] **Step 2: 실패 확인**

Run: `npm test 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '../src/synccreds.mjs'`

- [ ] **Step 3: 구현** — `src/synccreds.mjs` 생성:

```js
// 동기화 자격의 단일 출처 — env(자가 호스팅) 우선, 없으면 페어링으로 받은 파일.
// 파일은 WS_ROOT/.sync-credentials.json — 회사 폴더 밖(동기화 엔진이 회사 디렉토리만 걷으므로
// 클라우드로 복제되지 않는 기기 로컬 상태)이고, 서비스 키를 담으므로 0600으로 잠근다.
// epoch: 저장 시 증가 — sync.mjs 클라이언트·secretbox 파생 키가 캐시를 재구축하는 신호.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';

const FILE = '.sync-credentials.json';
let cache = null; // { root, creds }
let epoch = 0;

export const credsEpoch = () => epoch;

/** {url, key, owner}|null. env가 파일보다 항상 우선(기존 자가 호스팅 동작 불변). */
export function loadSyncCreds({ root = WS_ROOT, env = process.env } = {}) {
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, owner: env.ARGO_SYNC_OWNER || null };
  }
  if (cache && cache.root === root) return cache.creds;
  let creds = null;
  try {
    const { url, key, owner } = JSON.parse(readFileSync(join(root, FILE), 'utf8'));
    if (url && key) creds = { url, key, owner: owner || null };
  } catch { /* 파일 없음/손상 → 자격 없음 */ }
  cache = { root, creds };
  return creds;
}

/** 페어링 수신 자격 저장(0600) + 캐시 무효화. */
export async function saveSyncCreds({ url, key, owner }, { root = WS_ROOT } = {}) {
  if (!url || !key || !owner) throw new Error('저장할 자격 누락 (url/key/owner)');
  await mkdir(root, { recursive: true });
  const f = join(root, FILE);
  await writeFile(f, JSON.stringify({ url, key, owner }, null, 2));
  await chmod(f, 0o600);
  cache = null;
  epoch++;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`

- [ ] **Step 5: 커밋**

```bash
git add src/synccreds.mjs test/core.test.mjs
git commit -m "feat(pair): 동기화 자격 단일 출처 synccreds — env 우선, 페어링 파일 폴백"
```

---

### Task 3: sync.mjs·secretbox.mjs를 자격 출처에 재배선 (런타임 기동 가능화)

**Files:**
- Modify: `src/sync.mjs:32-36` (SYNC_ON), `:38-49` (EXCLUDE), `:51-60` (client), `:85-87` (isCloudLeader), `:279-296` (SYNC_OWNER/discoverRemote), `:299-302` (status), `:335-336` (ensureSync)
- Modify: `src/secretbox.mjs:12-25` (cryptoOn/key)

**Interfaces:**
- Consumes: `loadSyncCreds`, `credsEpoch` (Task 2)
- Produces: `syncOn() → boolean` (SYNC_ON 대체 — 외부 소비처 없음 확인됨: sync.mjs 내부 4곳뿐), `ensureSync()` 재호출 시 자격이 생겼으면 루프 기동 (Task 4 accept 라우트가 의존)

- [ ] **Step 1: sync.mjs 수정.** import에 `import { loadSyncCreds, credsEpoch } from './synccreds.mjs';` 추가 후:

`:32-36` SYNC_ON 상수 →
```js
// 동기화 스위치 — env(자가 호스팅) 또는 페어링 자격 파일. 호출 시점 평가:
// 페어링으로 자격이 런타임에 생겨도 재시작 없이 ensureSync 재호출로 켤 수 있다.
export const syncOn = () => !!loadSyncCreds() && process.env.ARGO_SYNC !== '0';
```

`:45` EXCLUDE에 자격 파일 추가 (심층 방어 — 루트 레벨 파일이라 walk에 안 잡히지만 명시):
```js
    base === '.sync-state.json' || base === '.device-id' || base === '.sync-credentials.json' || base === '.DS_Store' ||
```

`:51-60` client 싱글턴 → epoch 인지:
```js
let sb = null, sbEpoch = -1;
const client = () => {
  if (!sb || sbEpoch !== credsEpoch()) {
    const { url, key } = loadSyncCreds(); // syncOn() 게이트 뒤에서만 호출됨
    sb = createClient(url, key, {
      auth: { persistSession: false },
      // 타임아웃 필수 — 기본 fetch는 무한 대기라 요청 하나가 걸리면 동기화 전체가 영원히 멈춘다(실측)
      global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) }) },
    });
    sbEpoch = credsEpoch();
  }
  return sb;
};
```

`:86` → `return !syncOn() || leaseState.leader;`

`:282` `const SYNC_OWNER = ...` 삭제, `:286` discoverRemote 첫 줄 →
```js
  const fixed = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || null;
  const allow = fixed ? new Set([fixed]) : new Set(localOwners);
```
(`:279-281` 주석의 "ARGO_SYNC_OWNER" 설명에 "또는 페어링 자격의 owner" 한 줄 보강.)

`:299` status 초기화 `{ on: SYNC_ON, ...}` → `{ lastTs: null, lastError: '', companies: {} }` (on 제거), `:300-302` syncStatus →
```js
export function syncStatus() {
  return { ...status, on: syncOn(), leader: isCloudLeader(), companies: { ...status.companies } };
}
```

`:336` → `if (!syncOn()) return;`

- [ ] **Step 2: secretbox.mjs 수정.** import 추가 `import { loadSyncCreds, credsEpoch } from './synccreds.mjs';`, `:12-25` →

```js
// 호출 시점 평가 — env(자가 호스팅) 또는 페어링 자격 파일의 서비스 키. 테스트·런타임 주입 순서에 안전.
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || loadSyncCreds()?.key || null;
export const cryptoOn = () => !!serviceKey();

let cachedKey = null, keyEpoch = -1;
function key() {
  const sk = serviceKey();
  if (!sk) throw new Error('시크릿 암호화 키 없음 (SUPABASE_SERVICE_ROLE_KEY)');
  if (!cachedKey || keyEpoch !== credsEpoch()) {
    cachedKey = Buffer.from(hkdfSync(
      'sha256', sk,
      'argo-secret-sync-v1', // salt — 용도 고정
      'secretbox',           // info
      32,
    ));
    keyEpoch = credsEpoch();
  }
  return cachedKey;
}
```
파일 상단 주석(1-4행)의 "SUPABASE_SERVICE_ROLE_KEY에서 HKDF로 파생" 설명에 "(페어링 기기는 자격 파일의 동일 키)" 보강. **동시에 `src/runners.mjs:170` 부근의 스테일 주석**(".secrets.json 동기화 제외" — 3f26127 이후 실동작과 어긋남, 유료화 설계 문서에서 지적)을 "cryptoOn이면 봉투 암호문으로 동기화됨"으로 정정.

- [ ] **Step 3: 문법·회귀 확인**

Run: `node --check src/sync.mjs && node --check src/secretbox.mjs && node --check src/runners.mjs && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 문법 통과 + `# fail 0` (기존 secretbox 왕복·위변조 테스트 포함 전부 통과 — env 경로가 우선이므로 회귀 없음)

- [ ] **Step 4: SYNC_ON 잔존 참조 0건 확인**

Run: `grep -rn "SYNC_ON" src/ app/ test/ instrumentation* 2>/dev/null`
Expected: 출력 없음 (전부 syncOn()으로 대체됨)

- [ ] **Step 5: 커밋**

```bash
git add src/sync.mjs src/secretbox.mjs src/runners.mjs
git commit -m "feat(pair): 동기화 자격을 호출 시점 조회로 — 페어링 후 재시작 없이 기동"
```

---

### Task 4: API — 코드 발급(회사 스코프) + 수신(인스턴스 스코프)

**Files:**
- Create: `app/api/companies/[ws]/devices/route.js`
- Create: `app/api/pair/accept/route.js`

**Interfaces:**
- Consumes: `makePairCode`/`parsePairCode` (Task 1), `loadSyncCreds`/`saveSyncCreds` (Task 2), `ensureSync`·`syncOn` (Task 3), `loadCompany` (`src/workspace.mjs:56`), `guardCompany`/`currentUser`/`tenantDenied` (`app/auth.mjs`)
- Produces: `POST /api/companies/{ws}/devices → {code}`, `POST /api/pair/accept {code} → {ok:true}` (Task 5·6 UI가 호출)

- [ ] **Step 1: 발급 라우트** — `app/api/companies/[ws]/devices/route.js` 생성 (관례: `keys/route.js` 형태, params는 Promise):

```js
// 기기 페어링 — 이 회사(오너)의 동기화 자격을 연결 코드로 발급.
// 코드는 서비스 키를 담는다 — 응답으로만 나가고 절대 로그에 남기지 않는다.
import { loadCompany } from '../../../../../src/workspace.mjs';
import { loadSyncCreds } from '../../../../../src/synccreds.mjs';
import { makePairCode } from '../../../../../src/pairing.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    const creds = loadSyncCreds();
    if (!creds) return Response.json({ error: '이 기기에 동기화 자격이 없습니다 — 환경변수 설정 또는 페어링이 먼저 필요합니다' }, { status: 400 });
    const company = await loadCompany(ws);
    const owner = company?.ownerId || creds.owner || null;
    if (!owner) return Response.json({ error: '회사에 소유자(ownerId)가 없어 페어링할 수 없습니다' }, { status: 400 });
    return Response.json({ code: makePairCode({ url: creds.url, key: creds.key, owner }) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
```

- [ ] **Step 2: 수신 라우트** — `app/api/pair/accept/route.js` 생성 (인스턴스 스코프 — 회사 0개인 새 기기용. 게이트는 `app/api/companies/route.js:7-9`와 동일 패턴):

```js
// 페어링 수신 — 연결 코드를 자격 파일(0600)로 저장하고 동기화 루프를 재시작 없이 기동한다.
import { parsePairCode } from '../../../../src/pairing.mjs';
import { saveSyncCreds } from '../../../../src/synccreds.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { currentUser, tenantDenied } from '../../../auth.mjs';

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
    const td = tenantDenied(user); if (td) return td;
    const { code } = await req.json();
    const creds = parsePairCode(code); // 형식 불일치는 throw → 400
    await saveSyncCreds(creds);
    ensureSync(); // 자격이 방금 생겼다 — 부팅 때 안 떴던 루프를 지금 기동
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
```

- [ ] **Step 3: 문법 확인**

Run: `node --check "app/api/companies/[ws]/devices/route.js" && node --check app/api/pair/accept/route.js && npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3`
Expected: 문법 통과 + `✓ Compiled`

- [ ] **Step 4: 커밋**

```bash
git add "app/api/companies/[ws]/devices/route.js" app/api/pair/accept/route.js
git commit -m "feat(pair): 연결 코드 발급·수신 API — 발급은 회사 스코프, 수신은 인스턴스 스코프"
```

---

### Task 5: 설정 페이지 — 기기 카드 + i18n

**Files:**
- Modify: `app/c/[ws]/settings/page.jsx` (AI 연결 Section 바로 다음, 현재 128행 부근에 새 Section 삽입 + 파일 하단에 DevicesCard 컴포넌트 추가)
- Modify: `app/i18n.jsx` (settings.devices.* 키)

**Interfaces:**
- Consumes: `POST /api/companies/{ws}/devices` (Task 4), `api()` 헬퍼(`app/ui.jsx:246`), `useLang`/`Spinner`, 파일 내 공용 `fieldStyle`(`page.jsx:675`)
- Produces: 없음 (말단 UI)

- [ ] **Step 1: i18n 키 추가** — `app/i18n.jsx`의 settings.* 구획에 (규칙: ko/en 모두):

```js
'settings.devices.section': ['기기', 'Devices'],
'settings.devices.title': ['다른 기기와 연결', 'Link another device'],
'settings.devices.desc': ['연결 코드를 만들어 다른 기기의 홈 화면에 붙여넣으면, 이 회사(기억·크루·대화)가 그 기기로 내려갑니다.', 'Create a link code and paste it on another device’s home screen — this company (memory, crews, chats) syncs down there.'],
'settings.devices.generate': ['연결 코드 만들기', 'Create link code'],
'settings.devices.warn': ['이 코드는 비밀번호와 같습니다 — 붙여넣은 뒤 어디에도 남기지 마세요.', 'Treat this code like a password — do not leave it anywhere after pasting.'],
```

- [ ] **Step 2: Section 삽입** — `settings/page.jsx`의 `<Section label={t('settings.ai.section')}>...</Section>` 블록 바로 아래:

```jsx
      <Section label={t('settings.devices.section')}>
        <DevicesCard ws={ws} />
      </Section>
```

- [ ] **Step 3: DevicesCard 컴포넌트** — 같은 파일 하단(다른 카드 컴포넌트들 옆)에 추가. 카드 골격은 `page.jsx:730-735`, 복사 버튼은 `:766-776` 텔레그램 페어코드 관례:

```jsx
function DevicesCard({ ws }) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true); setError(''); setCopied(false);
    try { setCode((await api(`/api/companies/${ws}/devices`, {})).code); }
    catch (e) { setError(String(e.message)); }
    setBusy(false);
  }

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.devices.title')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{t('settings.devices.desc')}</p>
      {!code ? (
        <button type="button" className="btn btn-primary sm" onClick={generate} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={12} /> : null}{t('settings.devices.generate')}
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
              {code.slice(0, 26)}…{code.slice(-6)}
            </span>
            <button type="button" className="btn sm"
              onClick={() => { navigator.clipboard?.writeText(code).catch(() => {}); setCopied(true); }}>
              {copied ? '✓' : t('common.copy')}
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--warn, var(--fg-2))' }}>{t('settings.devices.warn')}</p>
        </>
      )}
      {error && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
```
(주의: `--warn` CSS 변수가 globals에 없으면 `var(--fg-2)` 폴백이 동작 — 새 변수를 추가하지 않는다.)

- [ ] **Step 4: 브라우저 확인** — dev 서버에서 설정 페이지 열기:

Run: dev 서버(`npm run dev`) → `http://localhost:3000/c/<기존회사>/settings`
Expected: "기기" 섹션 렌더, 버튼 클릭 시 (자격 있는 환경) 코드+복사 버튼 표시 / (자격 없으면) 한글 에러 메시지. 콘솔 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add "app/c/[ws]/settings/page.jsx" app/i18n.jsx
git commit -m "feat(pair): 설정에 기기 섹션 — 연결 코드 발급 카드"
```

---

### Task 6: 홈 — 코드 붙여넣기 수신 플로 + i18n

**Files:**
- Modify: `app/page.jsx` (회사 목록 section(89-119행)과 footer 사이에 수신 블록 추가)
- Modify: `app/i18n.jsx` (home.pair.* 키)

**Interfaces:**
- Consumes: `POST /api/pair/accept` (Task 4), `GET /api/companies` (기존), `api()`/`imeGuard`/`Spinner`
- Produces: 없음 (말단 UI)

- [ ] **Step 1: i18n 키 추가**:

```js
'home.pair.title': ['다른 기기에서 가져오기', 'Bring from another device'],
'home.pair.desc': ['기존 기기의 설정 → 기기에서 연결 코드를 만들어 여기 붙여넣으세요.', 'Create a link code in Settings → Devices on your other device and paste it here.'],
'home.pair.placeholder': ['연결 코드 붙여넣기 (argo-pair.v1.…)', 'Paste link code (argo-pair.v1.…)'],
'home.pair.btn': ['연결', 'Link'],
'home.pair.waiting': ['회사 수신 중 — 잠시 후 위 목록에 나타납니다', 'Receiving your companies — they will appear above shortly'],
'home.pair.done': ['수신 완료', 'Received'],
```

- [ ] **Step 2: 상태 + 핸들러** — `app/page.jsx`의 Home 컴포넌트에 추가:

```jsx
  const [pairCode, setPairCode] = useState('');
  const [pairState, setPairState] = useState(''); // '' | 'waiting' | 'done'
  const [pairError, setPairError] = useState('');

  async function pair(e) {
    e.preventDefault();
    if (!pairCode.trim() || pairState === 'waiting') return;
    setPairError('');
    try {
      await api('/api/pair/accept', { code: pairCode.trim() });
      setPairState('waiting'); setPairCode('');
      // 동기화 첫 사이클이 회사를 내려줄 때까지 폴링 (2초 × 최대 60회 — RunnerRow 관례)
      let n = 0;
      const iv = setInterval(async () => {
        try {
          const d = await api('/api/companies');
          if (d.companies.length > 0) { setCompanies(d.companies); setPairState('done'); clearInterval(iv); }
        } catch { /* 다음 틱 재시도 */ }
        if (++n >= 60) clearInterval(iv);
      }, 2000);
    } catch (err) { setPairError(String(err.message)); }
  }
```

- [ ] **Step 3: 수신 블록 렌더** — 회사 목록 `</section>` 직후, footer 앞:

```jsx
        {/* M-1 페어링 — 다른 기기의 회사를 연결 코드로 가져온다 (회사가 이미 있어도 추가 연결 가능) */}
        <section style={{ marginTop: 34 }}>
          <div className="microlabel" style={{ marginBottom: 8 }}>{t('home.pair.title')}</div>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 10 }}>{t('home.pair.desc')}</p>
          {pairState === 'waiting' ? (
            <p style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><Spinner size={13} />{t('home.pair.waiting')}</p>
          ) : pairState === 'done' ? (
            <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>{t('home.pair.done')}</p>
          ) : (
            <form onSubmit={pair} className="input-bar">
              <input suppressHydrationWarning className="mono" style={{ fontSize: 12 }}
                placeholder={t('home.pair.placeholder')}
                value={pairCode} onChange={(e) => setPairCode(e.target.value)} {...imeGuard} />
              <button className="btn" disabled={!pairCode.trim()}>{t('home.pair.btn')}</button>
            </form>
          )}
          {pairError && <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12.5 }}>{pairError}</p>}
        </section>
```

- [ ] **Step 4: 빌드 + 브라우저 확인**

Run: `npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3` → dev 서버에서 홈 열기
Expected: 빌드 통과. 홈 하단에 수신 블록 렌더. 쓰레기 코드 입력 시 "연결 코드 형식이 아닙니다" 에러 표시. 콘솔 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add app/page.jsx app/i18n.jsx
git commit -m "feat(pair): 홈에 연결 코드 수신 — 붙여넣기 → 회사 자동 수신"
```

---

### Task 7: E2E 검증 (두 기기 시뮬레이션) + README

**Files:**
- Modify: `README.md` (기기 추가 섹션 3~4줄)

**Interfaces:**
- Consumes: Task 1~6 전부
- Produces: M-1 완료 판정 근거

- [ ] **Step 1: 기기 A 기동** — 기존 `.env.local`(Supabase 자격)로:

```bash
ARGO_ROOT=/tmp/argo-pair-A npm run dev          # 포트 3000
```
브라우저에서 회사 1개 생성. 로컬 모드면 ownerId가 null이므로 동기화 대상이 되도록 주입:
```bash
python3 - <<'EOF'
import json, glob
f = glob.glob('/tmp/argo-pair-A/*/company.json')[0]
d = json.load(open(f)); d['ownerId'] = 'pair-e2e-owner'
json.dump(d, open(f, 'w'), ensure_ascii=False, indent=2)
print('ownerId 주입:', f)
EOF
```
크루에게 메시지 1개 보내 기억(vault/journal)과 chats를 만든다.

- [ ] **Step 2: 코드 발급** — 기기 A 설정 → 기기 → 연결 코드 만들기 → 복사.

- [ ] **Step 3: 기기 B 기동** — env 자격을 비운 셸에서 (같은 repo의 .env.local이 로드되므로 빈 값으로 덮어써 무력화):

```bash
NEXT_PUBLIC_SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= NEXT_PUBLIC_SUPABASE_ANON_KEY= \
ARGO_ROOT=/tmp/argo-pair-B npm run dev -- -p 3001
```
`http://localhost:3001` 홈 → 회사 0개 확인.

- [ ] **Step 4: 수신 판정** — 홈의 "다른 기기에서 가져오기"에 코드 붙여넣기 → 연결:

Expected (순서대로 전부):
1. "회사 수신 중" 표시 → 2분 내 회사 카드가 목록에 등장
2. 회사 열기 → 크루 존재, 채팅 이력 보임(chats 동기화), vault 기억 파일 존재 (`ls /tmp/argo-pair-B/*/vault/journal/`)
3. `/tmp/argo-pair-B/.sync-credentials.json` 존재 + 권한 600 (`ls -l`)
4. 기기 B에서 크루에게 메시지 → 45초 후 기기 A의 chats에 역방향 반영 (양방향 확인)
5. 두 서버 어느 로그에도 서비스 키 평문 없음 (`grep -c "eyJ" 로그` 등으로 확인)

- [ ] **Step 5: 정리 + README** — 두 서버 종료, `/tmp/argo-pair-A`·`/tmp/argo-pair-B` 삭제. README의 "24시간 상주 운항" 섹션 아래에:

```markdown
## 기기 추가 (페어링)

기존 기기 설정 → 기기 → **연결 코드 만들기** → 새 기기 홈의 **다른 기기에서 가져오기**에
붙여넣으면 회사(기억·크루·대화)가 내려온다. 코드는 동기화 자격을 담으므로 비밀번호처럼 다룰 것.
```

- [ ] **Step 6: 커밋**

```bash
git add README.md
git commit -m "docs: 기기 추가(페어링) 사용법"
```

---

## 알려진 한계 (M-2로 이연 — 계획 밖)

- 연결 코드에 서비스 키가 들어간다 — 자가 호스팅 전제에선 사용자가 이미 가진 값이지만, SaaS에선 M-2(테넌트 스코프 자격)가 payload를 교체한다. 포맷 버전(v1)이 그 교체 지점.
- 로컬 모드(AUTH_ON=false) 회사는 ownerId가 null → 동기화·페어링 불가. 이는 기존 sync 엔진의 전제이며 M-2 인증 합류에서 해소.
- 기억·대화는 스토리지에 평문(크레덴셜만 암호문) — M-3 암호화 확장 항목.
