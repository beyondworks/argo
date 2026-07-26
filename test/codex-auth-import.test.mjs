// codex 자격 반입 회귀 — "OAuth는 연결됐는데 크루 영입이 401로 죽는다" 신규 설치 신고(2026-07-26) 재발 방지.
// 뿌리: 턴 전용 CODEX_HOME에 auth.json을 **심링크로만** 반입하고 실패를 조용히 삼켜(Windows는 심링크에
// 개발자 모드·관리자 권한 필요) 자격 없는 홈으로 codex를 실행 → "Missing bearer or basic authentication
// in header". CI 스모크는 실자격이 필요해 이 경로를 못 태우므로(스모크는 claude 원클릭 전용) 여기서 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-codexauth-'));
const { importCodexAuth, recoverCodexAuth } = await import('../src/runners.mjs');

/** 베이스 홈(auth.json 있음/없음) + 턴 홈 한 쌍 */
async function homes({ withAuth = true, body = '{"tokens":{"access":"BASE"}}' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'argo-codexhome-'));
  const base = join(dir, 'base');
  const turn = join(dir, 'turn');
  await mkdir(base, { recursive: true });
  await mkdir(turn, { recursive: true });
  if (withAuth) await writeFile(join(base, 'auth.json'), body);
  return { base, turn };
}

test('심링크 반입: 원본을 가리키고 내용이 읽힌다(정상 경로)', async () => {
  const { base, turn } = await homes();
  const h = await importCodexAuth(base, turn);
  assert.equal(h.mode, 'link');
  assert.ok((await lstat(h.dst)).isSymbolicLink(), '심링크여야 한다');
  assert.match(await readFile(h.dst, 'utf8'), /BASE/, 'codex가 자격을 읽을 수 있어야 한다');
});

test('심링크가 실패하면 복사로 폴백한다 — 자격 없는 홈으로 실행되지 않는다(401 뿌리)', async () => {
  const { base, turn } = await homes();
  // 심링크 실패를 실제로 유발 — 목적지 선점(EEXIST). Windows EPERM과 같은 분기를 탄다.
  await writeFile(join(turn, 'auth.json'), 'STALE');
  const h = await importCodexAuth(base, turn);
  assert.equal(h.mode, 'copy', '심링크 실패를 삼키지 말고 복사해야 한다');
  assert.equal((await lstat(h.dst)).isSymbolicLink(), false, '복사본은 실파일이다');
  assert.match(await readFile(h.dst, 'utf8'), /BASE/, '선점 파일을 베이스 자격으로 덮어써야 한다');
});

test('자격 파일이 없어도 던지지 않는다 — 호스트 미로그인 등 자격 부재는 정상 경로다', async () => {
  const { base, turn } = await homes({ withAuth: false });
  const h = await importCodexAuth(base, turn);
  // POSIX symlink()는 대상이 없어도 성공한다(dangling) → 'link'. 심링크가 막힌 환경은 복사도 실패해 'none'.
  assert.ok(['link', 'none'].includes(h.mode), `예상 밖 mode=${h.mode}`);
  // 어느 쪽이든 자격이 **있는 것처럼 위장되지 않아야** 한다 — 읽으면 없음(ENOENT)이다.
  await assert.rejects(() => readFile(h.dst, 'utf8'), { code: 'ENOENT' });
  // dangling 링크의 이점도 잠근다: 그 경로로 codex가 로그인하면 베이스에 남는다(임시 홈과 함께 사라지지 않게).
  if (h.mode === 'link') {
    await writeFile(h.dst, '{"tokens":{"access":"FRESH_LOGIN"}}');
    assert.match(await readFile(join(base, 'auth.json'), 'utf8'), /FRESH_LOGIN/);
  }
});

test('복사 모드: CLI가 갱신한 토큰을 베이스로 회수한다(임시 홈과 함께 사라지지 않게)', async () => {
  const { base, turn } = await homes();
  await writeFile(join(turn, 'auth.json'), 'STALE'); // 복사 폴백 유도
  const h = await importCodexAuth(base, turn);
  assert.equal(h.mode, 'copy');
  // codex가 턴 중 토큰을 갱신한 상황 — 내용·mtime을 명시로 벌린다(파일시스템 시간 해상도 무관하게)
  await writeFile(h.dst, '{"tokens":{"access":"REFRESHED"}}');
  const now = Date.now() / 1000;
  await utimes(h.src, now - 60, now - 60);
  await utimes(h.dst, now, now);
  assert.equal(await recoverCodexAuth(h), true);
  assert.match(await readFile(h.src, 'utf8'), /REFRESHED/, '갱신 토큰이 베이스에 남아야 다음 턴이 산다');
});

test('회수는 필요할 때만 — 심링크 모드·none·오래된 dst는 베이스를 건드리지 않는다', async () => {
  const link = await homes();
  const lh = await importCodexAuth(link.base, link.turn);
  assert.equal(lh.mode, 'link');
  assert.equal(await recoverCodexAuth(lh), false, '심링크는 원본을 직접 쓴다 — 되돌릴 게 없다');
  assert.equal(await recoverCodexAuth({ mode: 'none' }), false);
  assert.equal(await recoverCodexAuth(null), false);

  const copy = await homes();
  await writeFile(join(copy.turn, 'auth.json'), 'STALE');
  const ch = await importCodexAuth(copy.base, copy.turn);
  const now = Date.now() / 1000;
  await utimes(ch.src, now, now);
  await utimes(ch.dst, now - 60, now - 60); // 턴 중 갱신 없음
  assert.equal(await recoverCodexAuth(ch), false, '갱신이 없으면 베이스를 덮어쓰지 않는다');
  assert.match(await readFile(ch.src, 'utf8'), /BASE/);
});
