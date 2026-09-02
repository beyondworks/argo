// 클라우드 자료 내보내기 회귀 테스트 — "데이터 인질 금지"의 실행 계약을 잠근다:
//  ① free 사용자 read 허용은 RLS select 정책이 근거 — 정책 정본에 pro 게이트가 없음을 정적으로 잠금
//  ② 자격 파일(.secrets·connections·mcp·직속 도트)은 사본에 절대 실리지 않는다(export.mjs 정본 재사용)
//  ③ 스토리지 키 base64url 세그먼트(u8-)가 한글 논리 경로로 복원된다(encSeg↔decSeg 왕복)
//  ④ 변조 키(경로 탈출)는 FS 조립 전에 걸러진다 ⑤ in-flight 가드 ⑥ 목적지 자동 선택·충돌 회피
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-cloudexp-'));
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-cloudexp-home-'));
const { encSeg } = await import('../src/sync.mjs');
const { decSeg, safeFolderName, pickExportTarget, exportCloudAll, exportCloudToLocal } = await import('../src/cloudexport.mjs');

const OWNER = 'owner-1';
const b64 = (s) => `u8-${Buffer.from(s).toString('base64url')}`;

// fake Supabase storage — 인메모리 Map<key, Buffer>. sync-integration.test.mjs와 동일 모사 규약
// (list는 prefix 바로 아래의 파일({id 있음})·폴더({id: null})를 낸다).
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
  return {
    _store: store,
    async download(key) {
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    // 서버 캡 모사: limit을 1000으로 요청해도 페이지당 최대 100개만 반환(offset 존중) — 프로덕션
    // storage-api가 limit을 캡해도 페이지네이션(빈 배치 종료)이 전량을 받는지 이 캡이 검증한다.
    async list(prefix, { offset = 0 } = {}) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const names = new Map();
      for (const k of store.keys()) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const seg = rest.split('/')[0];
        const isFile = !rest.includes('/');
        if (!names.has(seg) || isFile) names.set(seg, isFile);
      }
      const all = [...names].map(([name, isFile]) => ({ name, id: isFile ? 'f' : null }));
      return { data: all.slice(offset, offset + 100) };
    },
  };
}

test('RLS 정적 잠금: companies select 정책에 pro 게이트가 없다 — free 사용자 read가 이 기능의 근거', async () => {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let lastSelectDef = null, lastSelectFile = null;
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8');
    const m = sql.match(/create policy companies_owner_select[\s\S]*?;/i);
    if (m) { lastSelectDef = m[0]; lastSelectFile = f; }
  }
  assert.ok(lastSelectDef, 'companies_owner_select 정책 정의가 마이그레이션에 존재');
  assert.ok(!/is_pro/i.test(lastSelectDef),
    `select 정책(${lastSelectFile})에 is_pro가 들어가면 만료 사용자의 내보내기(read)가 끊긴다 — 데이터 인질 금지 계약 위반`);
});

test('encSeg↔decSeg 왕복: 한글·특수문자 세그먼트가 논리 경로로 복원된다', () => {
  for (const s of ['기억.md', 'plain-name_1.json', '한글 폴더', 'mix한글.txt', 'a b']) {
    assert.equal(decSeg(encSeg(s)), s, s);
  }
  assert.equal(decSeg('company.json'), 'company.json', 'ASCII는 무변환');
});

test('safeFolderName: 경로 구분자·예약 문자 제거, 빈 결과는 폴백', () => {
  assert.equal(safeFolderName('내 회사', 'ws'), '내 회사');
  assert.equal(safeFolderName('a/b\\c:d', 'ws'), 'a b c d');
  assert.equal(safeFolderName('...', 'ws'), 'ws');
  assert.equal(safeFolderName(null, 'ws'), 'ws');
});

test('pickExportTarget: YYYYMMDD 기본, 존재하면 -2·-3…, .partial 잔재도 회피', () => {
  const now = new Date(2026, 6, 28); // 로컬 2026-07-28
  const base = join('/docs', 'Argo-cloud-export-20260728');
  assert.equal(pickExportTarget('/docs', { now, exists: () => false }), base);
  assert.equal(pickExportTarget('/docs', { now, exists: (p) => p === base }), `${base}-2`);
  assert.equal(pickExportTarget('/docs', { now, exists: (p) => p === `${base}.partial` }), `${base}-2`, '.partial 진행 흔적과도 경합하지 않는다');
  assert.equal(pickExportTarget('/docs', { now, exists: (p) => p === base || p === `${base}-2` }), `${base}-3`);
});

test('exportCloudAll: 자료는 한글 경로로 복원되고 자격·인프라 파일은 사본에 없다', async () => {
  const fake = fakeStorage({
    // 회사 1 — 표시명 '내 회사', 한글 파일·폴더, 자격 3종, 동기화 인프라
    [`${OWNER}/ws-a/company.json`]: JSON.stringify({ id: 'ws-a', name: '내 회사' }),
    [`${OWNER}/ws-a/__manifest__.json`]: JSON.stringify({ files: {} }),
    [`${OWNER}/ws-a/connections.json`]: 'argosecret.v2:봉투-봇토큰',
    [`${OWNER}/ws-a/${b64('.secrets.json')}`]: 'sk-실키', // 도트 세그먼트는 encSeg 대상 아님이지만 방어적으로도 잠근다
    [`${OWNER}/ws-a/.secrets.json`]: 'sk-실키',
    [`${OWNER}/ws-a/mcp.json`]: '{"env":{"TOKEN":"mcp-토큰"}}',
    [`${OWNER}/ws-a/vault/notes/${b64('기억.md')}`]: '# 기억\n',
    [`${OWNER}/ws-a/vault/.emptyFolderPlaceholder`]: '', // Supabase 빈 폴더 마커 — 사본·집계 제외

    [`${OWNER}/ws-a/${b64('한글 폴더')}/${b64('노트.md')}`]: '노트 본문',
    [`${OWNER}/ws-a/chats/main.json`]: '{"messages":[]}',
    // 회사 2 — company.json 없음 → wsId 폴백
    [`${OWNER}/ws-b/agents/tester.md`]: '---\nname: 테스터\n---\n',
    // 오너 직속 인프라 — 회사가 아니다
    [`${OWNER}/_device-lease.json`]: '{"deviceId":"d"}',
    [`${OWNER}/.tombstones/old.json`]: '{"wsId":"old"}',
  });
  const targetDir = join(process.env.HOME, 'out-1');
  const r = await exportCloudAll({ storage: fake, owner: OWNER, targetDir });
  assert.equal(r.companies, 2);
  assert.equal(r.files, 5, 'ws-a(company.json·기억.md·노트.md·main.json)=4 + ws-b(tester.md)=1 — 자격·인프라 제외 후');
  assert.equal(await readFile(join(targetDir, '내 회사', 'vault', 'notes', '기억.md'), 'utf8'), '# 기억\n', '한글 파일명 복원');
  assert.equal(await readFile(join(targetDir, '내 회사', '한글 폴더', '노트.md'), 'utf8'), '노트 본문', '한글 폴더명 복원');
  assert.ok(existsSync(join(targetDir, 'ws-b', 'agents', 'tester.md')), '표시명 없으면 wsId 폴더');
  for (const leak of ['connections.json', '.secrets.json', 'mcp.json', '__manifest__.json']) {
    assert.equal(existsSync(join(targetDir, '내 회사', leak)), false, `${leak} 미유출`);
  }
  assert.equal(existsSync(join(targetDir, '내 회사', 'vault', '.emptyFolderPlaceholder')), false, '빈 폴더 마커 미포함');
  assert.equal(existsSync(join(targetDir, '_device-lease.json')), false, '오너 직속 인프라 미포함');
  assert.equal(existsSync(join(targetDir, '.tombstones')), false, 'tombstone 미포함');
  assert.equal(existsSync(`${targetDir}.partial`), false, '.partial 잔재 없음(성공 시 rename)');
  // 사본 전체 그렙 — 시크릿 문자열이 어디에도 없다(경로 누락 방어의 이중 확인, export.test와 동일 관용구)
  async function grepAll(dir) {
    let hit = false;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) hit = hit || await grepAll(p);
      else {
        const body = await readFile(p, 'utf8');
        hit = hit || body.includes('sk-실키') || body.includes('봉투-봇토큰') || body.includes('mcp-토큰');
      }
    }
    return hit;
  }
  assert.equal(await grepAll(targetDir), false, '사본 어디에도 시크릿 문자열 없음');
});

test('exportCloudAll: 변조 키(경로 탈출 디코드)는 걸러지고, 열 수 없는 봉투는 파일 단위로 건너뛴다', async () => {
  const fake = fakeStorage({
    [`${OWNER}/ws-c/company.json`]: JSON.stringify({ id: 'ws-c', name: 'C' }),
    [`${OWNER}/ws-c/${b64('../탈출.md')}`]: '워크스페이스 밖으로', // 디코드 결과에 '/' 포함 — 조립 금지
    [`${OWNER}/ws-c/vault/${b64('..')}`]: '상위 참조', // '..' 세그먼트
    // 봉투 접두인데 계정 키가 없어 열 수 없다 — 암호문 쓰레기를 사본에 남기지 않는다
    [`${OWNER}/ws-c/vault/enc.md`]: Buffer.concat([Buffer.from('argosecret.v2:'), Buffer.from([1, 2, 3, 4])]),
  });
  const targetDir = join(process.env.HOME, 'out-2');
  const r = await exportCloudAll({ storage: fake, owner: OWNER, targetDir });
  assert.equal(r.files, 1, 'company.json만');
  assert.equal(r.unsafe, 2, '탈출 시도 2건 집계');
  assert.equal(r.failed, 1, '개봉 실패 1건 집계 — 무음 아님');
  assert.equal(existsSync(join(process.env.HOME, '탈출.md')), false, '목적지 밖 쓰기 없음');
  assert.equal(existsSync(join(targetDir, 'C', 'vault', 'enc.md')), false, '암호문 미기록');
});

test('exportCloudAll: 동명 회사는 (wsId) 접미로 구분, 빈 클라우드는 empty', async () => {
  const fake = fakeStorage({
    [`${OWNER}/ws-1/company.json`]: JSON.stringify({ name: '같은이름' }),
    [`${OWNER}/ws-2/company.json`]: JSON.stringify({ name: '같은이름' }),
  });
  const targetDir = join(process.env.HOME, 'out-3');
  const r = await exportCloudAll({ storage: fake, owner: OWNER, targetDir });
  assert.equal(r.companies, 2);
  assert.ok(existsSync(join(targetDir, '같은이름', 'company.json')));
  assert.ok(existsSync(join(targetDir, '같은이름 (ws-2)', 'company.json')), '두 번째 동명 회사는 wsId 접미');
  await assert.rejects(
    () => exportCloudAll({ storage: fakeStorage({}), owner: OWNER, targetDir: join(process.env.HOME, 'out-4') }),
    (e) => e.code === 'empty',
  );
  assert.equal(existsSync(join(process.env.HOME, 'out-4')), false, 'empty면 폴더를 만들지 않는다');
});

test('exportCloudAll: 열거(list) 실패는 전체 실패 — 부분 목록으로 "다 받았다"는 거짓 안심을 만들지 않는다', async () => {
  const fake = fakeStorage({ [`${OWNER}/ws-e/company.json`]: '{}' });
  const origList = fake.list.bind(fake);
  let calls = 0;
  fake.list = async (...a) => (++calls === 2 ? { data: null, error: { message: 'timeout' } } : origList(...a));
  const targetDir = join(process.env.HOME, 'out-5');
  await assert.rejects(() => exportCloudAll({ storage: fake, owner: OWNER, targetDir }), (e) => e.code === 'list-failed');
  assert.equal(existsSync(targetDir), false);
  assert.equal(existsSync(`${targetDir}.partial`), false, '실패 시 부분 잔재 정리');
});

test('exportCloudAll: 회사 세그먼트(wsId)도 검증 — WS_ID_RE 불일치는 조립 전 차단(분리 검수 HIGH)', async () => {
  const fake = fakeStorage({
    [`${OWNER}/evil..name/x.md`]: '변조 회사 세그먼트', // 점 접두는 아니지만 회사 생성 규칙 밖
    [`${OWNER}/UPPER/x.md`]: '대문자 — 생성 규칙 밖',
    [`${OWNER}/ws-ok/company.json`]: JSON.stringify({ name: '정상' }),
  });
  const targetDir = join(process.env.HOME, 'out-6');
  const r = await exportCloudAll({ storage: fake, owner: OWNER, targetDir });
  assert.equal(r.companies, 1, '정상 회사만');
  assert.equal(r.unsafe, 2, '변조 세그먼트 2건 집계');
  assert.equal(existsSync(join(targetDir, 'evil..name')), false);
  assert.equal(existsSync(join(targetDir, 'UPPER')), false);
});

test('exportCloudAll: 페이지네이션 — 서버가 페이지당 100개로 캡해도 전량을 받는다(빈 배치 종료)', async () => {
  const seed = { [`${OWNER}/ws-p/company.json`]: JSON.stringify({ name: '페이지' }) };
  for (let i = 1; i <= 150; i++) seed[`${OWNER}/ws-p/vault/f${String(i).padStart(3, '0')}.md`] = `본문 ${i}`;
  const targetDir = join(process.env.HOME, 'out-7');
  const r = await exportCloudAll({ storage: fakeStorage(seed), owner: OWNER, targetDir });
  assert.equal(r.files, 151, 'company.json + 150개 — 첫 페이지(100)에서 끊기면 부분 사본');
  assert.equal(await readFile(join(targetDir, '페이지', 'vault', 'f150.md'), 'utf8'), '본문 150');
});

test('exportCloudAll: 계정 키 확보 시 봉투(ARGO_ENC_VAULT 계열) 파일이 평문으로 복원된다', async () => {
  // sync 사이클 없이도 내보내기 경로가 봉투를 연다는 계약(분리 검수 HIGH — resolveStorage가 ensureAccountKey 호출).
  // 여기선 코어 경로를 잠근다: 키 캐시 확보 → sealSecret 봉투 → exportCloudAll이 평문 기록.
  const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
  const { sealSecret } = await import('../src/secretbox.mjs');
  const keyB64 = Buffer.alloc(32, 7).toString('base64');
  const fakeSb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: keyB64 }, error: null }) }) }) }) };
  assert.ok(await ensureAccountKey(fakeSb, OWNER), '계정 키 확보');
  try {
    const fake = fakeStorage({
      [`${OWNER}/ws-enc/company.json`]: JSON.stringify({ name: '봉투' }),
      [`${OWNER}/ws-enc/vault/${b64('암호기억.md')}`]: sealSecret(Buffer.from('# 열린 기억\n')),
    });
    const targetDir = join(process.env.HOME, 'out-8');
    const r = await exportCloudAll({ storage: fake, owner: OWNER, targetDir });
    assert.equal(r.failed, 0, '키가 있으면 개봉 실패 없음');
    assert.equal(await readFile(join(targetDir, '봉투', 'vault', '암호기억.md'), 'utf8'), '# 열린 기억\n', '봉투가 평문으로 복원');
  } finally { clearAccountKey(); } // 뒤 테스트(키 부재 계약)에 영향 금지
});

test('UI 소스 계약: CloudExportRow는 lastError 분기 사슬과 직교로 렌더된다(분리 검수 CRITICAL)', async () => {
  // 렌더 테스트 인프라가 없어 소스 계약으로 잠근다(no-hardcoded-runner-label과 동일 계열).
  // ENFORCE off 구간의 free 사용자는 RLS push 거부로 lastError 분기에 걸린다 — 사슬 안에 버튼을
  // 넣으면 대상 사용자가 버튼을 영영 못 본다. 직교 렌더 표현식이 소스에 있어야 한다.
  const src = await readFile(join(process.cwd(), 'app', 'c', '[ws]', 'settings', 'page.jsx'), 'utf8');
  // 표현식 전문을 리터럴로 박아뒀더니 plan 출처를 계정 기준으로 바꾸는 정당한 수정에 거짓 red가 났다
  // (2026-08-05). 잠글 것은 **직교 렌더라는 불변식**이지 조건식의 철자가 아니다.
  const line = src.split('\n').find((l) => l.includes('<CloudExportRow'));
  assert.ok(line, '렌더 지점이 없다');
  assert.match(line, /^\s*\{\(.*paywalled.*\|\|.*free.*\) && <CloudExportRow \/>\}$/,
    '직교(&&) 렌더가 아니다 — 분기 사슬(lastError) 안으로 들어가면 대상 사용자가 버튼을 못 본다');
  assert.equal(src.split('<CloudExportRow').length - 1, 1, '렌더 지점은 정확히 한 곳(사슬 안 중복 금지)');
});

test('exportCloudToLocal: 서비스 모드 오너 오설정 — 요청자와 다르면 owner-mismatch(분리 검수 MED)', async () => {
  // 서비스 자격 env 주입(실서버 아님). 계정 키 캐시를 fake sb로 미리 채워 ensureAccountKey가
  // 캐시 히트로 즉시 반환하게 한다 — 실접속 시도(수 초)로 스위트를 늘어뜨리지 않는다(재검수 LOW).
  const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
  const keyB64 = Buffer.alloc(32, 9).toString('base64');
  const fakeSb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: keyB64 }, error: null }) }) }) }) };
  await ensureAccountKey(fakeSb, 'svc-owner');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.ARGO_SYNC_OWNER = 'svc-owner';
  try {
    await assert.rejects(() => exportCloudToLocal({ requesterId: 'someone-else' }), (e) => e.code === 'owner-mismatch');
  } finally {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ARGO_SYNC_OWNER;
    clearAccountKey();
  }
});

test('exportCloudToLocal: in-flight 가드 — 진행 중 재클릭은 busy로 거절', async () => {
  // 자격 없는 환경 — 첫 호출은 자격 해석 단계에서 끝나지만, 가드는 그 전에 걸린다(동기 선점).
  // 모듈이 import 시점에 잡은 객체를 그대로 mutate한다(교체하면 다른 객체를 보게 돼 테스트가 무의미).
  globalThis.__argoCloudExport.busy = true;
  await assert.rejects(() => exportCloudToLocal(), (e) => e.code === 'busy');
  globalThis.__argoCloudExport.busy = false;
  // 자격 전무(서비스 자격·기기 세션 없음) → no-creds. finally가 가드를 반드시 푼다.
  await assert.rejects(() => exportCloudToLocal(), (e) => e.code === 'no-creds');
  assert.equal(globalThis.__argoCloudExport.busy, false, '실패 후에도 가드 해제');
});
