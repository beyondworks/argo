// 크루 카드 경로 판정의 경계 테스트 — "목록엔 뜨는데 열 수도 지울 수도 없는 크루"를 막는다.
//
// 실사용 신고 2026-08-02: 크루를 해고하려는데 "크루를 찾을 수 없습니다"만 반복됐다.
// 원인은 한 규칙에 두 일을 시킨 것 — `SLUG_RE`가 **경로 안전**과 **작명 규칙**을 겸했다.
// 사이드바 목록은 agents/의 `*.md`를 그대로 읽는데(readdir), 카드 API는 SLUG_RE로 걸렀다.
// 그래서 동기화·볼트 임포트·수동 복사·옛 버전으로 들어온 `클선생.md` 같은 파일은
// **목록엔 뜨지만 열람 404 / 해고 400**이 되어 화면에서 지울 방법이 아예 없었다(실측 재현).
//
// 이 파일이 잠그는 불변식은 하나다:
//   **목록이 내놓는 slug는 전부 카드 API가 다룰 수 있어야 한다.**
// 규칙과 목록이 어긋나면 언제나 목록이 앞서고 규칙이 막는다 — 그 간극이 곧 이 신고다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-slug-'));
const { readAgentCard, removeAgentCard } = await import('../src/persona.mjs');
const { listAgents } = await import('../src/hub.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'test-co';
// 밖에서 들어올 수 있는 이름들 — 우리 영입 경로는 이런 이름을 만들지 않지만, 파일은 만들어진다.
const OUTSIDE = ['클선생', 'Mr_Kim', 'pepper copy', 'a.b', '팀장-2'];
await mkdir(paths(WS).agents, { recursive: true });
for (const slug of [...OUTSIDE, 'pepper']) {
  await writeFile(join(paths(WS).agents, `${slug}.md`), `---\nname: ${slug}\nrole: 테스트\n---\n\n본문\n`);
}

test('불변식: 목록이 내놓는 slug는 전부 카드 API가 읽을 수 있다', async () => {
  const listed = (await listAgents(WS)).map((a) => a.slug);
  assert.ok(listed.length >= OUTSIDE.length, '전제: 외부 유입 파일이 목록에 뜬다');
  const broken = [];
  for (const slug of listed) {
    try { await readAgentCard(WS, slug); } catch (e) { broken.push(`${slug}: ${e.message}`); }
  }
  assert.deepEqual(broken, [],
    '목록엔 뜨는데 못 읽는 크루가 있으면, 사용자는 사이드바에서 보면서도 열지도 지우지도 못한다');
});

test('밖에서 들어온 카드도 해고된다 — 보관함으로 이동(복구 가능)', async () => {
  for (const slug of OUTSIDE) {
    await removeAgentCard(WS, slug);   // 던지면 실패
  }
  const left = (await readdir(paths(WS).agents)).filter((f) => f.endsWith('.md'));
  assert.deepEqual(left, ['pepper.md'], '해고한 카드는 agents/에서 빠진다');
  const archived = await readdir(join(paths(WS).agents, '.archive'));
  assert.equal(archived.length, OUTSIDE.length, '지우는 게 아니라 보관함으로 — 복구 가능해야 한다');
});

test('경로 이탈은 여전히 막는다 — 문자 규칙을 뺀 자리를 봉쇄가 지킨다', async () => {
  for (const bad of ['../company', '../../etc/passwd', 'a/b', 'sub/dir/x', '/etc/passwd', '', null, 123]) {
    await assert.rejects(() => readAgentCard(WS, bad), (e) => e?.badRequest === true || e?.notFound === true,
      `이탈·비정상 입력이 통과하면 안 된다: ${JSON.stringify(bad)}`);
  }
  // 이탈은 클라이언트 잘못이다 — 라우트가 400으로 내보낼 수 있게 표시가 붙어야 한다(500 아님).
  await assert.rejects(() => readAgentCard(WS, '../company'), (e) => e.badRequest === true);
});

test('없는 크루는 notFound 표시 — 라우트가 404와 500을 가릴 수 있어야 한다', async () => {
  await assert.rejects(() => readAgentCard(WS, 'nobody-here'), (e) => e.notFound === true && !e.badRequest);
});

test('작명 규칙은 생성 문에서 강제된다 — 우리가 만드는 크루는 규칙을 지킨다', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../src/persona.mjs', import.meta.url), 'utf8'));
  assert.match(src, /if \(!SLUG_RE\.test\(slug\)\) throw new Error/,
    'SLUG_RE가 주석에만 남고 아무 데서도 안 쓰이면, 규칙을 옮겼다는 말이 거짓이 된다');
  assert.doesNotMatch(src, /function cardPath[\s\S]{0,200}?SLUG_RE\.test/,
    'cardPath가 다시 작명 규칙으로 막으면 이 신고가 그대로 재발한다');
});
