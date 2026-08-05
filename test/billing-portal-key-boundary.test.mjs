// 구독 관리 포털 — **LS API 키가 기기로 나가지 않는다**는 경계를 잠근다.
//
// 이 경계가 무너지는 순간이 설계가 무너지는 순간이다(docs/billing-portal-design.md):
// 데스크톱 앱은 사용자 기기에서 Next 서버를 돌리므로, 앱이 읽는 코드나 릴리스 빌드 env에
// LEMONSQUEEZY_API_KEY가 들어가면 전 사용자에게 결제 API 키가 배포된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/** app/·src/ 아래 모든 소스에서 LEMONSQUEEZY_API_KEY 참조를 모은다(재귀 — 비재귀 스캔은 거짓 안심). */
async function refs(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !/\.(mjs|js|jsx|ts)$/.test(e.name)) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    if (p.includes('node_modules') || p.includes('/.next/')) continue;
    // 주석의 언급이 아니라 **실제 읽기**만 센다 — 이 경계를 설명하는 주석까지 잡으면 게이트가 무뎌진다
    if (/process\.env\.LEMONSQUEEZY_API_KEY/.test(await readFile(p, 'utf8'))) out.push(p.replace(root, ''));
  }
  return out;
}

// 이관 3단계(설계서)가 끝나면 이 목록은 비어야 한다. 지금은 /api/me/billing의 대사(reconcile)가
// 아직 LS를 직접 부른다 — 그래서 데스크톱에서는 그 기능이 조용히 꺼져 있다(키가 없으므로).
// **여기에 새 항목을 추가하지 마라.** 줄이는 방향으로만 고친다.
const KNOWN_GAP = ['app/api/me/billing/route.js'];

test('앱 서버 코드는 LS API 키를 읽지 않는다 — 키는 Edge Function에만 있다', async () => {
  const hits = [...await refs('app'), ...await refs('src')];
  const unexpected = hits.filter((h) => !KNOWN_GAP.includes(h));
  assert.deepEqual(unexpected, [], `앱 코드가 LS API 키를 읽는다: ${unexpected.join(', ')}\n`
    + '데스크톱 앱은 사용자 기기에서 이 코드를 돌린다 — 키가 필요하면 supabase/functions로 옮겨라.');
  // 이관이 끝났는데 목록이 남아 있으면 그것도 결함이다(죽은 예외가 다음 위반을 가린다)
  for (const g of KNOWN_GAP) assert.ok(hits.includes(g), `이관 완료됨 — KNOWN_GAP에서 ${g}를 지워라`);
});

test('릴리스 빌드에 LS API 키를 주입하지 않는다', async () => {
  const wf = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.ok(!wf.includes('LEMONSQUEEZY_API_KEY'),
    '릴리스 워크플로가 LS API 키를 빌드 env로 넘긴다 — 설치본에 키가 실린다');
});

test('포털 라우트는 Edge Function을 부른다 — LS API를 직접 부르지 않는다', async () => {
  const src = await readFile(join(root, 'app/api/me/billing/portal/route.js'), 'utf8');
  assert.match(src, /functions\/v1\/ls-portal/, '포털 발급이 Edge Function 경유가 아니다');
  assert.doesNotMatch(src, /api\.lemonsqueezy\.com/, '앱 라우트가 LS API를 직접 부른다 — 키가 필요해진다');
});
