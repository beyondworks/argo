// CSRF 가드 배선 — app/api/companies/[ws]/route.js의 PUT(회사 설정 저장, fullAuto·credSync 등)
// (분리 검수 MEDIUM, 2026-09-26). 라우트 파일은 next/headers를 top-import해 node --test로 직접
// 열 수 없다(레포 관례 — test/auth-guard-lang.test.mjs 머리 주석과 같은 제약). 그래서
// ① csrfDenied 자체의 통과/차단 행동은 authmsg.mjs 순수 계층에서 이미 잠겨 있고(auth-guard-lang),
// ② 여기서는 "그 함수가 이 라우트의 PUT 안에서 실제로 호출되는가"를 소스 배선으로 보조 확인한다
//    (connector-catalog ⑧·auth-guard-lang과 같은 관례).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('PUT /api/companies/[ws] — csrfDenied를 guardCompany보다 먼저 호출하고, 실패 시 즉시 반환한다', async () => {
  const src = await load('../app/api/companies/[ws]/route.js');
  assert.match(src, /import \{ guardCompany, authError, requestLang, csrfDenied \} from '\.\.\/\.\.\/\.\.\/auth\.mjs';/, 'csrfDenied를 auth.mjs에서 임포트하지 않는다');
  const putStart = src.indexOf('export async function PUT(');
  assert.ok(putStart > 0, 'PUT 핸들러가 없다');
  const putEnd = src.indexOf('\nexport async function DELETE(', putStart);
  const put = src.slice(putStart, putEnd === -1 ? undefined : putEnd);
  assert.match(put, /const csrf = csrfDenied\(req\); if \(csrf\) return csrf;/, 'PUT이 csrfDenied를 호출하지 않는다 — 악성 페이지의 simple PUT이 사장 클릭 없이 회사 설정을 바꿀 수 있다');
  const csrfIdx = put.indexOf('csrfDenied(req)');
  const guardIdx = put.indexOf('guardCompany(ws)');
  assert.ok(csrfIdx >= 0 && guardIdx >= 0 && csrfIdx < guardIdx, 'csrf 검사가 guardCompany보다 먼저 와야 한다(approvals·connectors 라우트와 같은 순서)');
});

test('참고: GET·DELETE는 이 회귀 범위 밖 — DELETE(회사 보관)에는 csrfDenied가 없다(검수 요청 범위=PUT만, 별도 판단 필요)', async () => {
  const src = await load('../app/api/companies/[ws]/route.js');
  const delStart = src.indexOf('export async function DELETE(');
  const del = src.slice(delStart);
  // 현재 상태를 있는 그대로 기록 — DELETE에 csrfDenied가 생기면 이 단언을 뒤집어 갱신할 것
  assert.doesNotMatch(del, /csrfDenied/, 'DELETE에 csrfDenied가 생겼다면 이 테스트를 갱신하라(의도된 변경인지 확인 후)');
});

test('csrfDenied 자체 행동(재확인) — 이 라우트로 오는 same-origin fetch는 통과, cross-site는 차단', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key';
  const { csrfDenied } = await import('../app/authmsg.mjs');
  const fakeReq = (h = {}) => ({ headers: new Headers(h) });
  // 설정 페이지의 실제 호출 형태(app/c/[ws]/settings/page.jsx: fetch(`/api/companies/${ws}`, { method: 'PUT', ... }))는
  // 상대경로 same-origin fetch라 브라우저가 Sec-Fetch-Site: same-origin을 스스로 붙인다 — 클라이언트 코드 변경 불필요.
  assert.equal(csrfDenied(fakeReq({ 'sec-fetch-site': 'same-origin' })), null, '설정 화면의 fetch(같은 출처)는 통과해야 한다');
  assert.equal(csrfDenied(fakeReq({ 'sec-fetch-site': 'cross-site' }))?.status, 403, '악성 페이지의 cross-site PUT은 막혀야 한다');
});
