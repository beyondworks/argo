// 기능 라우트 오류 문구 표시 언어 — 공통 가드(#333 L5)의 기능 라우트 확장 후속.
// 잠그는 것:
//  ① apiError — ko 문구는 v0.1.52 출하 프로덕션 문자열 그대로(바이트 동일 = 회귀 0), en은 리터럴
//     고정 + 무한글, errorCode·status 동봉, 미등록 코드는 fail-loud(throw).
//  ② recover 오입력 판별 — openDekWithKek의 코드 오입력 throw가 E2EE_BAD_CODE 코드를 실어,
//     라우트가 문자열 매칭 없이 표시 언어로 다시 그린다(행동 — 옳은 코드는 여전히 열린다).
//  ③ e2ee 라우트 배선(소스) — apiError 코드 실존·전 코드 사용·언어 인자 필수·쿠키 실판독.
//     라우트 실호출은 currentUser의 cookies()가 요청 스코프 밖에서 throw라 불가(connector-catalog
//     프로브 실측 관례) — 소스 배선으로 잠근다.
//  ④ 이관 ko 문구의 사전 밖 재등장 금지 — app/ 전체 error: 리터럴 트립와이어(auth-guard-lang 관례).
//  ⑤ companies GET 실호출 — 프리셋 표시 언어 = ?lang 1순위 · argo-lang 쿠키 폴백 · 무단서 ko.
//  ⑥ detail 병기(후속 이관) — 동적 접미가 붙던 문구(마켓·크루 카드·vault rel)는 `문구: detail`
//     바이트 계약. apiMsgText = 커스텀 응답 모양(market 200 소프트 오류) 자리의 문구 전용 출구.
//  ⑦ 후속 6라우트 배선(소스) — 호출부 전 형태 강제(코드 리터럴 + lang 변수 + detail 식별자만) +
//     사전 전 코드의 전역 배선(미배선 코드 = 미번역 잔존) — market·feedback·agents·vault·devices·pair.
//  ⑧ 실호출(인증 off·임시 ARGO_ROOT) — vault·agents·feedback·devices 라우트의 오류 표시 언어 행동
//     (en 쿠키 = 영어 + errorCode, 무단서 = 기존 ko 바이트).
//  ⑨ src/ 이관 코어 문구의 무코드 throw 재등장 금지 — ④는 app/의 error: 리터럴만 본다(2차 검수
//     LOW-5 사각). 이관된 코어 문구(persona NOT_FOUND·CARD_NAME_REQUIRED, e2ee E2EE_BAD_CODE)는
//     src/ 어디서든 기계 코드를 싣고 있어야 한다. src/ 전체 한글 문구 전수조사는 별건.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apimsg-')); // 워크스페이스 임포트보다 먼저
// AUTH off — companies GET 실호출(⑤)이 가드를 지나 프리셋 본문을 관측하기 위해(마켓 라우트 관례).
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const { API_MSG, apiError, apiMsgText } = await import('../app/apimsg.mjs');
const { generateRecoveryCode, deriveRecoveryKek, wrapDekWithKek, openDekWithKek } = await import('../src/e2ee.mjs');

// ── ① apiError 행동 ──────────────────────────────────────────────────────────
// 기대표는 사전(API_MSG)과 독립적으로 고정한다 — 사전을 되비추면 동어반복이라 게이트가 아니다.
// ko는 변경 전 라우트가 실제로 내리던 v0.1.52 프로덕션 문자열(인접 행동 핀 — 바이트 동일해야 회귀 0).
const EXPECT = {
  e2ee_session_required: { status: 401, ko: '기기 연동 세션이 필요합니다 — Argo 앱에서 로그인해 주세요', en: 'A linked device session is required — sign in from the Argo app' },
  e2ee_already_on_this: { status: 400, ko: '이미 이 기기에서 켜져 있습니다', en: 'Already enabled on this device' },
  e2ee_already_on_other: { status: 409, ko: '이미 다른 기기에서 켜져 있습니다 — 그 기기에서 이 기기를 승인해 주세요', en: 'Already enabled on another device — approve this device from that device' },
  e2ee_plan_required: { status: 403, ko: '종단간 암호화는 동기화가 도는 상태(Pro·체험)에서 켤 수 있습니다', en: 'End-to-end encryption can be turned on while sync is active (Pro or trial)' },
  e2ee_no_key_here: { status: 400, ko: '이 기기에 열쇠가 없습니다 — 열쇠 보유 기기에서 승인해 주세요', en: 'This device holds no key — approve from a device that has the key' },
  e2ee_approve_target_required: { status: 400, ko: '승인할 기기를 지정해 주세요', en: 'Specify a device to approve' },
  e2ee_target_pubkey_missing: { status: 404, ko: '대상 기기의 공개키가 없습니다(앱 업데이트·로그인 확인)', en: 'The target device has no public key (check for app updates and sign-in)' },
  e2ee_retry_later: { status: 429, ko: '잠시 후 다시 시도해 주세요', en: 'Please try again shortly' },
  e2ee_already_has_key: { status: 400, ko: '이미 이 기기에 열쇠가 있습니다', en: 'This device already has the key' },
  e2ee_no_recovery: { status: 404, ko: '복구 코드가 설정돼 있지 않습니다', en: 'No recovery code is set up' },
  e2ee_bad_recovery_code: { status: 400, ko: '복구 코드가 맞지 않습니다', en: 'The recovery code is incorrect' },
  e2ee_revoke_target_required: { status: 400, ko: '제거할 기기를 지정해 주세요', en: 'Specify a device to remove' },
  e2ee_revoke_self: { status: 400, ko: '이 기기 자신은 제거할 수 없습니다', en: 'This device cannot remove itself' },
  e2ee_unknown_action: { status: 400, ko: '알 수 없는 action', en: 'Unknown action' },
  // 후속 이관(6 라우트) — ko는 변경 전 각 라우트가 실제로 내리던 프로덕션 문자열(detail 접미 앞부분).
  // status: null = 문구 전용(market 200 소프트 오류 — 응답 모양은 라우트 소유, apiError는 fail-loud)
  market_top_failed: { status: null, ko: '추천 목록 로드 실패', en: 'Failed to load recommendations' },
  market_remote_failed: { status: null, ko: '원격 마켓 연결 실패', en: 'Remote market connection failed' },
  feedback_cloud_only: { status: 400, ko: '클라우드 모드(로그인)에서만 피드백을 보낼 수 있습니다', en: 'Feedback can be sent only in cloud mode (signed in)' },
  feedback_message_required: { status: 400, ko: '내용이 필요합니다', en: 'A message is required' },
  feedback_save_failed: { status: 500, ko: '저장에 실패했습니다. 잠시 후 다시 시도해 주세요', en: 'Failed to save. Please try again shortly' },
  crew_not_found: { status: 404, ko: '크루를 찾을 수 없습니다', en: 'Crew not found' },
  crew_card_read_failed: { status: 500, ko: '크루 카드를 읽지 못했습니다', en: 'Could not read the crew card' },
  // 3차 — 크루 카드 쓰기 경로(PUT·PATCH·DELETE). ko는 변경 전 라우트 catch가 String(e.message)로
  // 통과시키던 코어 원문·인라인 리터럴 그대로. status 400 유지(오늘의 catch 그대로 — 404 격상은 별건).
  crew_missing: { status: 400, ko: '존재하지 않는 크루입니다', en: 'This crew does not exist' },
  crew_card_name_required: { status: 400, ko: 'frontmatter에 name이 필요합니다', en: 'The frontmatter needs a name field' },
  crew_card_body_required: { status: 400, ko: '카드 내용이 필요합니다', en: 'Card content is required' },
  vault_doc_not_found: { status: 404, ko: '문서를 찾을 수 없습니다', en: 'Document not found' },
  devices_no_sync_creds: { status: 400, ko: '이 기기에 동기화 자격이 없습니다 — 환경변수 설정 또는 페어링이 먼저 필요합니다', en: 'This device has no sync credentials — set the environment variables or pair it first' },
  devices_no_owner: { status: 400, ko: '회사에 소유자(ownerId)가 없어 페어링할 수 없습니다', en: 'The company has no owner (ownerId), so it cannot be paired' },
  pair_owner_mismatch: { status: 403, ko: '연결 코드의 소유자가 현재 로그인 사용자와 다릅니다', en: 'The pairing code owner does not match the signed-in user' },
};

test('apiError — ko 문구는 기존 프로덕션 문자열 그대로 + 상태코드 + errorCode 동봉', async () => {
  assert.deepEqual(Object.keys(API_MSG).sort(), Object.keys(EXPECT).sort(), '사전 코드 집합 = 기대표(누락·잉여 즉시 노출)');
  for (const [code, exp] of Object.entries(EXPECT)) {
    if (exp.status === null) { // 문구 전용(market) — apiError 오호출은 results 없는 200 오류가 되므로 차단
      assert.throws(() => apiError(code, 'ko'), undefined, `${code} 문구 전용 코드의 apiError 오호출 차단(분리 검수 LOW-1)`);
      assert.equal(apiMsgText(code, 'ko'), exp.ko, `${code} ko 문구 회귀 0`);
      continue;
    }
    const res = apiError(code, 'ko');
    assert.equal(res.status, exp.status, `${code} 상태코드`);
    const body = await res.json();
    assert.equal(body.error, exp.ko, `${code} ko 문구 회귀 0`);
    assert.equal(body.errorCode, code, `${code} errorCode 동봉`);
  }
});

test('apiError — en 문구 리터럴 고정, 미지원 언어값·미지정은 ko 폴백', async () => {
  for (const [code, exp] of Object.entries(EXPECT)) {
    if (exp.status === null) { // 문구 전용 — en 문구·무한글은 apiMsgText로 같은 강도 검사
      assert.equal(apiMsgText(code, 'en'), exp.en, `${code} en 문구`);
      assert.ok(!/[가-힣]/.test(apiMsgText(code, 'en')), `${code} en에 한글 없음`);
      continue;
    }
    const body = await apiError(code, 'en').json();
    assert.equal(body.error, exp.en, `${code} en 문구`);
    assert.ok(!/[가-힣]/.test(body.error), `${code} en에 한글 없음`);
    assert.equal(body.errorCode, code);
  }
  assert.equal((await apiError('e2ee_retry_later', 'de').json()).error, EXPECT.e2ee_retry_later.ko, '미지원 값 = ko');
  assert.equal((await apiError('e2ee_retry_later', undefined).json()).error, EXPECT.e2ee_retry_later.ko, '언어 미지정 = ko(기존 행동)');
});

test('apiError — 미등록 코드는 조용한 오문구 대신 throw(오타 fail-loud)', () => {
  assert.throws(() => apiError('no_such_code', 'ko'));
});

// ── ② recover 오입력 판별(행동) ──────────────────────────────────────────────
test('openDekWithKek — 코드 오입력은 E2EE_BAD_CODE 코드를 싣고, 옳은 코드는 여전히 열린다', async () => {
  const code = generateRecoveryCode();
  const salt = randomBytes(16).toString('base64');
  const kek = deriveRecoveryKek(code, salt);
  const dek = randomBytes(32);
  const wrap = wrapDekWithKek(kek, dek);
  assert.deepEqual(openDekWithKek(kek, wrap), dek, '인접 핀 — 옳은 코드 개봉은 그대로 동작');
  const wrongKek = deriveRecoveryKek(generateRecoveryCode(), salt); // 다른 코드 = 오입력
  try {
    openDekWithKek(wrongKek, wrap);
    assert.fail('오입력이 열리면 안 된다');
  } catch (e) {
    assert.equal(e.code, 'E2EE_BAD_CODE', '라우트가 문자열 매칭 없이 판별할 기계 코드');
    assert.equal(e.message, '복구 코드가 맞지 않습니다', 'ko 원문 유지(코드 없는 소비자 회귀 0)');
  }
});

// ── ②-2 persona 쓰기 경로 기계 코드(행동 — 3차) ─────────────────────────────
test('persona 쓰기 3함수 — 없는 크루 NOT_FOUND·name 없는 카드 CARD_NAME_REQUIRED 코드, ko 원문·성공 경로 유지', async () => {
  const { saveAgentCard, updateAgentMeta, removeAgentCard } = await import('../src/persona.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const p = paths('w1');
  await mkdir(p.agents, { recursive: true });
  const card = '---\nname: 철수\nrole: 백엔드\n---\n# 철수 — 백엔드\n';
  await writeFile(join(p.agents, 'chulsoo.md'), card);
  // 인접 핀 — 있는 크루의 정상 저장은 그대로(코드 부여가 성공 경로를 건드리지 않는다)
  assert.equal((await saveAgentCard('w1', 'chulsoo', card)).name, '철수');
  // 기계 코드 + ko 원문 바이트 — 코드를 안 읽는 소비자(approval-actions)는 오늘과 동일하게 받는다
  const MISSING = { code: 'NOT_FOUND', message: '존재하지 않는 크루입니다' };
  await assert.rejects(() => saveAgentCard('w1', 'ghost', card), MISSING);
  await assert.rejects(() => updateAgentMeta('w1', 'ghost', { name: 'x' }), MISSING);
  await assert.rejects(() => removeAgentCard('w1', 'ghost'), MISSING);
  await assert.rejects(() => saveAgentCard('w1', 'chulsoo', '# 이름 없는 카드'),
    { code: 'CARD_NAME_REQUIRED', message: 'frontmatter에 name이 필요합니다' });
});

// ── ③ e2ee 라우트 배선(소스 — 실호출 불가 자리의 보조 잠금) ──────────────────
test('배선 — e2ee 라우트: apiError 코드 실존·전 코드 사용·언어 인자 필수·쿠키 실판독·오입력 판별', async () => {
  const src = await readFile(new URL('../app/api/me/e2ee/route.js', import.meta.url), 'utf8');
  const used = new Set();
  // 호출부 전 형태 강제 — 인자 누락뿐 아니라 상수화(`, 'ko')`)도 그 갈래만 영구 한국어 고정이다
  // (분리 검수 MEDIUM-1 변이 실증: 상수화가 한 인자 금지 스캔을 그대로 통과했다. 호출부 단위
  // 게이트 교훈의 재적중 — 게이트는 함수가 아니라 호출부 형태로 잠근다).
  const calls = [...src.matchAll(/apiError\([^)]*\)/g)];
  assert.ok(calls.length > 0, 'apiError 호출이 하나도 없다 — 전환 자체가 풀린 것');
  for (const m of calls) {
    const shape = m[0].match(/^apiError\('([a-z0-9_]+)', lang\)$/);
    assert.ok(shape, `호출 형태 위반(코드 리터럴 + lang 변수만 허용): ${m[0]}`);
    assert.ok(shape[1] in API_MSG, `미등록 코드 '${shape[1]}' (오타 = 해당 갈래 500)`);
    used.add(shape[1]);
  }
  // e2ee 계열 전 코드 — 다른 계열(market_ 등)은 각자의 라우트가 배선한다(⑦ 전역 배선 검사)
  for (const code of Object.keys(API_MSG).filter((c) => c.startsWith('e2ee_'))) {
    assert.ok(used.has(code), `사전의 ${code}가 라우트에 배선되지 않음 — 그 갈래는 미번역 잔존`);
  }
  assert.match(src, /langFromCookieHeader\(req\.headers\.get\('cookie'\)\)/, 'argo-lang 쿠키를 읽지 않는다(상수화 변이)');
  assert.match(src, /e2\?\.code === 'E2EE_BAD_CODE'/, 'recover 오입력을 코드로 판별하지 않는다(문자열 매칭·원문 통과 변이)');
});

// ── ④ 이관 ko 문구의 사전 밖 재등장 금지 — auth-guard-lang 트립와이어와 같은 관례 ──
test('배선 — 이관 e2ee ko 문구가 error: 리터럴로 재등장하면 red', async () => {
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(mjs|js|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  // 프리픽스 앵커(error: 직후 시작) — apimsg.mjs의 ko: 정의부와 타 문구의 부분 포함(예: feedback의
  // '저장에 실패했습니다. 잠시 후…')은 걸리지 않는다.
  const banned = new RegExp(`error:\\s*['"\`](${[
    '기기 연동 세션이 필요합니다', '이미 이 기기에서 켜져 있습니다', '이미 다른 기기에서 켜져 있습니다',
    '종단간 암호화는 동기화가 도는', '이 기기에 열쇠가 없습니다', '승인할 기기를 지정해',
    '대상 기기의 공개키가 없습니다', '잠시 후 다시 시도해 주세요', '이미 이 기기에 열쇠가 있습니다',
    '복구 코드가 설정돼 있지 않습니다', '복구 코드가 맞지 않습니다', '제거할 기기를 지정해',
    '이 기기 자신은 제거할 수 없습니다', '알 수 없는 action',
    // 후속 이관(6 라우트) — 괄호 포함 문구는 regex 안전 지점에서 절단('클라우드 모드'·'회사에 소유자').
    // 프리픽스 앵커라 '수신 크루와 내용이…'·'제목과 내용이…'(유지 판정 별개 문구)는 안 걸린다.
    '추천 목록 로드 실패', '원격 마켓 연결 실패', '클라우드 모드', '내용이 필요합니다',
    '저장에 실패했습니다', '크루를 찾을 수 없습니다', '크루 카드를 읽지 못했습니다',
    '문서를 찾을 수 없습니다', '이 기기에 동기화 자격이 없습니다', '회사에 소유자', '연결 코드의 소유자가',
    // 3차 — 크루 카드 쓰기 경로. '카드 내용이 필요합니다'는 이관으로 라우트 리터럴이 소멸했다.
    '존재하지 않는 크루입니다', 'frontmatter에 name이', '카드 내용이 필요합니다',
  ].join('|')})`);
  for (const f of files) {
    const m = (await readFile(f, 'utf8')).match(banned);
    assert.equal(m, null, `${f}: e2ee 문구 하드코딩 재등장 — apiError로 합류할 것: ${m?.[0] ?? ''}`);
  }
});

// ── ⑨ src/ 이관 코어 문구 — 무코드 throw 재등장 금지(2차 검수 LOW-5 사각의 부분 봉합) ──
// ④는 app/의 error: 리터럴만 본다. src/ 코어가 이관 문구를 코드 없이 throw하면 라우트 catch의
// String(e.message) 통과로 이관이 조용히 풀린다(persona가 실제 그랬던 경로). 이관된 코어 문구는
// src/ 어디서든 같은 줄 또는 다음 줄에 기계 코드가 실려 있어야 한다. src/ 전체 한글 전수는 별건.
test('배선 — 이관 코어 ko 문구는 src/에서 기계 코드 없이 재등장 금지', async () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(mjs|js)$/.test(e.name)).map((e) => join(e.parentPath, e.name));
  const MIGRATED = ['존재하지 않는 크루입니다', 'frontmatter에 name이 필요합니다', '복구 코드가 맞지 않습니다'];
  let seen = 0;
  for (const f of files) {
    const lines = (await readFile(f, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const s of MIGRATED) {
        if (!line.includes(s)) continue;
        seen += 1;
        // e2ee 관례(err.code = 다음 줄)까지 허용 — 창 2줄 안에 code 표기가 있어야 한다
        assert.match(lines.slice(i, i + 2).join('\n'), /\bcode\s*[:=]\s*'/,
          `${f}:${i + 1}: 이관 문구 '${s}'가 기계 코드 없이 등장 — Object.assign(new Error(...), { code })로 실을 것`);
      }
    });
  }
  assert.ok(seen >= 6, `이관 코어 throw가 사라졌다(${seen}곳) — 문구를 바꿨다면 MIGRATED와 사전·라우트를 함께 옮길 것`);
});

// ── ⑤ companies GET 실호출 — 프리셋 표시 언어 (리졸브 훅 = connector-catalog ⑧ 관례) ──
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const companiesRoute = await import('../app/api/companies/route.js');
const getPresets = async (qs = '', headers = {}) => {
  const res = await companiesRoute.GET(new Request(`http://127.0.0.1/api/companies${qs}`, { headers }));
  assert.equal(res.status, 200);
  return (await res.json()).presets;
};
const hasKo = (ps) => ps.some((p) => /[가-힣]/.test(p.label + p.desc));

test('companies GET — 프리셋 표시 언어: ?lang 1순위, 부재 시 argo-lang 쿠키 폴백, 무단서는 ko', async () => {
  const bare = await getPresets();
  assert.ok(bare.length >= 3, '프리셋이 내려온다');
  assert.equal(bare[0].label, '크리에이터', '무단서 = ko(기존 행동 바이트 핀)');
  const cookieEn = await getPresets('', { cookie: 'argo-lang=en' });
  assert.ok(!hasKo(cookieEn), `en 쿠키 = 영어 프리셋(검수 실측 표면): ${JSON.stringify(cookieEn)}`);
  assert.equal(cookieEn[0].label, 'Creator');
  assert.ok(!hasKo(await getPresets('?lang=en')), '?lang=en = 영어(기존 행동 유지)');
  assert.ok(hasKo(await getPresets('?lang=ko', { cookie: 'argo-lang=en' })), '?lang=ko가 쿠키 en보다 우선(화면 UI 언어 1순위)');
  assert.ok(hasKo(await getPresets('?lang=de', { cookie: 'argo-lang=ko' })), '무효 ?lang은 버리고 쿠키(ko)로');
});

// ── ⑥ detail 병기(후속 이관) — 동적 접미 문구의 바이트 계약 + apiMsgText 행동 ──────
test('apiMsgText/apiError — detail은 `문구: detail` 접미(기존 동적 문구 바이트), 없으면 문구만', async () => {
  assert.equal(apiMsgText('vault_doc_not_found', 'ko', 'notes/a.md'), '문서를 찾을 수 없습니다: notes/a.md');
  assert.equal(apiMsgText('vault_doc_not_found', 'en', 'notes/a.md'), 'Document not found: notes/a.md');
  assert.equal(apiMsgText('market_top_failed', 'ko'), '추천 목록 로드 실패', 'detail 없으면 문구만');
  assert.equal(apiMsgText('market_remote_failed', 'de', 'x'), '원격 마켓 연결 실패: x', '미지원 언어값 = ko');
  assert.throws(() => apiMsgText('no_such_code', 'ko'), undefined, '미등록 코드 fail-loud(apiError와 동일 계약)');
  const res = apiError('crew_card_read_failed', 'en', 'boom');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'Could not read the crew card: boom', 'apiError 3인자도 같은 접미 계약');
  assert.equal(body.errorCode, 'crew_card_read_failed');
});

// ── ⑦ 후속 6라우트 배선(소스) — 호출부 전 형태 강제 + 사전 전 코드 전역 배선 ────────
// 기대 호출을 리터럴로 핀한다 — lang 상수화(`'ko'`)·detail 누락·코드 오타 전부 리터럴 불일치로 red.
// e2ee 라우트는 위 ③이 같은 강도로 잠근다(집합 검사만 여기 합류).
const ROUTES = [
  { file: '../app/api/companies/[ws]/market/route.js', langVar: 'uiLang', calls: [
    // 200 + { results: [], error } 소프트 오류 계약 — Response는 라우트가 만들고 문구만 apiMsgText
    { s: "apiMsgText('market_top_failed', uiLang, detail)", n: 1 },
    { s: "apiMsgText('market_remote_failed', uiLang, detail)", n: 1 },
  ] },
  { file: '../app/api/feedback/route.js', calls: [
    { s: "apiError('feedback_cloud_only', lang)", n: 1 },
    { s: "apiError('feedback_message_required', lang)", n: 1 },
    { s: "apiError('feedback_save_failed', lang)", n: 1 },
  ] },
  { file: '../app/api/companies/[ws]/agents/[slug]/route.js', calls: [
    { s: "apiError('crew_not_found', lang)", n: 1 },
    { s: "apiError('crew_card_read_failed', lang, detail)", n: 1 },
    // 3차 — 쓰기 경로: 코어 NOT_FOUND 판별(PUT·PATCH·DELETE) 3곳 + PUT 카드 검증 2곳
    { s: "apiError('crew_missing', lang)", n: 3 },
    { s: "apiError('crew_card_name_required', lang)", n: 1 },
    { s: "apiError('crew_card_body_required', lang)", n: 1 },
  ] },
  { file: '../app/api/companies/[ws]/vault/route.js', calls: [
    { s: "apiError('vault_doc_not_found', lang, rel)", n: 2 }, // GET(깨진 위키링크)·DELETE(선삭제 노트)
  ] },
  { file: '../app/api/companies/[ws]/devices/route.js', calls: [
    { s: "apiError('devices_no_sync_creds', lang)", n: 1 },
    { s: "apiError('devices_no_owner', lang)", n: 1 },
  ] },
  { file: '../app/api/pair/accept/route.js', calls: [
    { s: "apiError('pair_owner_mismatch', lang)", n: 1 },
  ] },
];

test('배선 — 후속 6라우트: 기대 호출 리터럴·전 호출 형태 일치·쿠키 실판독·사전 전 코드 전역 배선', async () => {
  const wired = new Set();
  for (const r of ROUTES) {
    const src = await readFile(new URL(r.file, import.meta.url), 'utf8');
    const langVar = r.langVar ?? 'lang';
    assert.match(src, new RegExp(`const ${langVar} = langFromCookieHeader\\(req\\.headers\\.get\\('cookie'\\)\\)`),
      `${r.file}: argo-lang 쿠키를 읽지 않는다(상수화 변이)`);
    const found = [...src.matchAll(/\bapi(?:Error|MsgText)\([^)]*\)/g)].map((m) => m[0]);
    assert.ok(found.length > 0, `${r.file}: apiError/apiMsgText 호출이 없다 — 전환 자체가 풀린 것`);
    const expected = new Map(r.calls.map((c) => [c.s, c.n]));
    for (const call of found) {
      assert.ok(expected.has(call), `${r.file}: 기대 밖 호출 형태(코드 리터럴+${langVar} 변수+식별자 detail만 허용): ${call}`);
    }
    for (const { s, n } of r.calls) {
      const cnt = found.filter((c) => c === s).length;
      assert.equal(cnt, n, `${r.file}: ${s} 호출 수 ${cnt} ≠ ${n}(갈래 누락·중복)`);
      const code = s.match(/'([a-z0-9_]+)'/)[1];
      assert.ok(code in API_MSG, `${r.file}: 미등록 코드 '${code}'`);
      wired.add(code);
    }
  }
  // 전역 배선 — 사전의 비-e2ee 코드는 위 6라우트가 전부 소유한다(미배선 코드 = 미번역 잔존·죽은 사전)
  const all = Object.keys(API_MSG).filter((c) => !c.startsWith('e2ee_')).sort();
  assert.deepEqual([...wired].sort(), all, '사전 비-e2ee 코드 집합 = 6라우트 배선 집합');
});

// ── ⑧ 실호출 — 인증 off·임시 ARGO_ROOT에서 이관 라우트의 오류 표시 언어 행동 ─────────
// 리졸브 훅(⑤에서 등록)을 재사용한다. [ws] 괄호 경로는 pathToFileURL로 임포트.
const { pathToFileURL } = await import('node:url');
const routeImport = (rel) => import(pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href);
const P = (params) => ({ params: Promise.resolve(params) });

test('실호출 — vault GET: 없는 문서 404 = 표시 언어 문구 + rel 접미 + errorCode', async () => {
  const { GET } = await routeImport('../app/api/companies/[ws]/vault/route.js');
  const en = await GET(new Request('http://127.0.0.1/api/companies/w1/vault?rel=nope.md', { headers: { cookie: 'argo-lang=en' } }), P({ ws: 'w1' }));
  assert.equal(en.status, 404);
  const enBody = await en.json();
  assert.equal(enBody.error, 'Document not found: nope.md');
  assert.equal(enBody.errorCode, 'vault_doc_not_found');
  const ko = await GET(new Request('http://127.0.0.1/api/companies/w1/vault?rel=nope.md'), P({ ws: 'w1' }));
  assert.equal((await ko.json()).error, '문서를 찾을 수 없습니다: nope.md', '무단서 = 기존 ko 바이트(회귀 0)');
});

test('실호출 — vault DELETE: 선삭제 노트 404 = 표시 언어 문구 + rel 접미(분리 검수 MEDIUM-1 — GET의 lang 선언이 DELETE 상수화를 가리는 구멍 봉합)', async () => {
  const { DELETE } = await routeImport('../app/api/companies/[ws]/vault/route.js');
  const mk = (headers) => new Request('http://127.0.0.1/api/companies/w1/vault?rel=notes/gone.md', { method: 'DELETE', headers });
  const en = await DELETE(mk({ cookie: 'argo-lang=en' }), P({ ws: 'w1' }));
  assert.equal(en.status, 404);
  const enBody = await en.json();
  assert.equal(enBody.error, 'Document not found: notes/gone.md');
  assert.equal(enBody.errorCode, 'vault_doc_not_found');
  const ko = await DELETE(mk({}), P({ ws: 'w1' }));
  assert.equal((await ko.json()).error, '문서를 찾을 수 없습니다: notes/gone.md', '무단서 = 기존 ko 바이트(회귀 0)');
});

test('실호출 — agents GET: 없는 크루 404(stale 링크) = 표시 언어 문구 + errorCode', async () => {
  const { GET } = await routeImport('../app/api/companies/[ws]/agents/[slug]/route.js');
  const en = await GET(new Request('http://127.0.0.1/api/companies/w1/agents/ghost', { headers: { cookie: 'argo-lang=en' } }), P({ ws: 'w1', slug: 'ghost' }));
  assert.equal(en.status, 404);
  const enBody = await en.json();
  assert.equal(enBody.error, 'Crew not found');
  assert.equal(enBody.errorCode, 'crew_not_found');
  const ko = await GET(new Request('http://127.0.0.1/api/companies/w1/agents/ghost'), P({ ws: 'w1', slug: 'ghost' }));
  assert.equal((await ko.json()).error, '크루를 찾을 수 없습니다', '무단서 = 기존 ko 바이트(회귀 0)');
});

test('실호출 — feedback POST: 인증 off 게이트 400 = 표시 언어 문구 + errorCode', async () => {
  const { POST } = await routeImport('../app/api/feedback/route.js');
  const mk = (headers) => new Request('http://127.0.0.1/api/feedback', { method: 'POST', headers });
  const en = await POST(mk({ cookie: 'argo-lang=en' }));
  assert.equal(en.status, 400);
  const enBody = await en.json();
  assert.equal(enBody.error, 'Feedback can be sent only in cloud mode (signed in)');
  assert.equal(enBody.errorCode, 'feedback_cloud_only');
  assert.equal((await (await POST(mk({}))).json()).error, '클라우드 모드(로그인)에서만 피드백을 보낼 수 있습니다', '무단서 = 기존 ko 바이트');
});

test('실호출 — devices POST: 동기화 자격 없음 400 = 표시 언어 문구 + errorCode', async () => {
  const { POST } = await routeImport('../app/api/companies/[ws]/devices/route.js');
  const mk = (headers) => new Request('http://127.0.0.1/api/companies/w1/devices', { method: 'POST', headers });
  const en = await POST(mk({ cookie: 'argo-lang=en' }), P({ ws: 'w1' }));
  assert.equal(en.status, 400);
  const enBody = await en.json();
  assert.equal(enBody.error, 'This device has no sync credentials — set the environment variables or pair it first');
  assert.equal(enBody.errorCode, 'devices_no_sync_creds');
  assert.equal((await (await POST(mk({}), P({ ws: 'w1' }))).json()).error,
    '이 기기에 동기화 자격이 없습니다 — 환경변수 설정 또는 페어링이 먼저 필요합니다', '무단서 = 기존 ko 바이트');
});

// ── ⑧-2 실호출(3차) — 크루 카드 쓰기 경로. 핸들러별 lang 산출을 각각 실검증한다
// (2차 검수 MEDIUM-1 교훈: 한 핸들러의 lang 선언이 다른 핸들러의 상수화·미이관을 가린다).
test('실호출 — agents PUT: 빈 카드·name 없는 카드·해고된 크루 400 = 표시 언어 문구 + errorCode', async () => {
  const { PUT } = await routeImport('../app/api/companies/[ws]/agents/[slug]/route.js');
  const put = (body, headers) => PUT(new Request('http://127.0.0.1/api/companies/w1/agents/ghost', {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), P({ ws: 'w1', slug: 'ghost' }));
  const cases = [
    // [body, en 문구, errorCode, ko 문구] — 판별 순서대로: 본문 검증 → name 검증 → 존재 검증
    [{ md: '' }, 'Card content is required', 'crew_card_body_required', '카드 내용이 필요합니다'],
    [{ md: '# 이름 없는 카드' }, 'The frontmatter needs a name field', 'crew_card_name_required', 'frontmatter에 name이 필요합니다'],
    [{ md: '---\nname: 유령\n---\n# 유령\n' }, 'This crew does not exist', 'crew_missing', '존재하지 않는 크루입니다'],
  ];
  for (const [body, enMsg, code, koMsg] of cases) {
    const en = await put(body, { cookie: 'argo-lang=en' });
    assert.equal(en.status, 400);
    const b = await en.json();
    assert.equal(b.error, enMsg);
    assert.equal(b.errorCode, code);
    assert.equal((await (await put(body, {})).json()).error, koMsg, `무단서 = 기존 ko 바이트(회귀 0): ${code}`);
  }
});

test('실호출 — agents PATCH: 해고된 크루 400 = 표시 언어 문구 + errorCode(stale 패널의 범위 토글·신원 수정)', async () => {
  const { PATCH } = await routeImport('../app/api/companies/[ws]/agents/[slug]/route.js');
  const patch = (headers) => PATCH(new Request('http://127.0.0.1/api/companies/w1/agents/ghost', {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'x' }),
  }), P({ ws: 'w1', slug: 'ghost' }));
  const en = await patch({ cookie: 'argo-lang=en' });
  assert.equal(en.status, 400);
  const b = await en.json();
  assert.equal(b.error, 'This crew does not exist');
  assert.equal(b.errorCode, 'crew_missing');
  assert.equal((await (await patch({})).json()).error, '존재하지 않는 크루입니다', '무단서 = 기존 ko 바이트(회귀 0)');
});

test('실호출 — agents DELETE: 이미 해고된 크루 재시도 400 = 표시 언어 문구 + errorCode', async () => {
  const { DELETE } = await routeImport('../app/api/companies/[ws]/agents/[slug]/route.js');
  const del = (headers) => DELETE(new Request('http://127.0.0.1/api/companies/w1/agents/ghost', { method: 'DELETE', headers }), P({ ws: 'w1', slug: 'ghost' }));
  const en = await del({ cookie: 'argo-lang=en' });
  assert.equal(en.status, 400);
  const b = await en.json();
  assert.equal(b.error, 'This crew does not exist');
  assert.equal(b.errorCode, 'crew_missing');
  assert.equal((await (await del({})).json()).error, '존재하지 않는 크루입니다', '무단서 = 기존 ko 바이트(회귀 0)');
});
