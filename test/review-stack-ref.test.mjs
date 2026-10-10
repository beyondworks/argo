// review-stack.sh up <브랜치>가 아직 푸시 안 한 로컬 커밋을 버리고 옛 origin으로 띄우던 결함(10/10) — 로컬·원격 중 앞선 쪽을 고른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/review-stack.sh', import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
const pick = (repo, ref) => execFileSync('bash', ['-c', `REVIEW_STACK_SOURCE=1 . "$0"; pick_sha "$1" "$2"`, SCRIPT, repo, ref], { encoding: 'utf8', env: { ...process.env, ARGO_REVIEW_HOME: join(repo, '.rh') } }).trim();

test('pick_sha — 로컬이 앞서면 로컬, 뒤처지면 origin, 이름이 한쪽에만 있으면 그쪽', { skip: process.platform === 'win32' }, (t) => {
  const d = mkdtempSync(join(tmpdir(), 'rs-ref-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const bare = join(d, 'o.git'), a = join(d, 'a');
  git(d, 'init', '-q', '--bare', bare); git(d, 'clone', '-q', bare, a);
  git(a, 'commit', '-q', '--allow-empty', '-m', 'c1'); git(a, 'checkout', '-q', '-b', 'feat'); git(a, 'push', '-q', 'origin', 'feat');
  const pushed = git(a, 'rev-parse', 'HEAD');
  git(a, 'commit', '-q', '--allow-empty', '-m', 'local-only'); const ahead = git(a, 'rev-parse', 'HEAD');
  assert.equal(pick(a, 'feat'), ahead, '푸시 안 한 로컬 커밋으로 띄운다');
  git(a, 'reset', '-q', '--hard', pushed); git(a, 'commit', '-q', '--allow-empty', '-m', 'remote-new'); git(a, 'push', '-q', 'origin', 'feat');
  const remoteNew = git(a, 'rev-parse', 'HEAD'); git(a, 'reset', '-q', '--hard', pushed);
  assert.equal(pick(a, 'feat'), remoteNew, '로컬이 뒤처지면 origin');
  assert.equal(pick(a, 'origin/feat'), remoteNew, 'origin/이름을 직접 주면 그대로');
  git(a, 'checkout', '-q', '-b', 'only-local'); assert.equal(pick(a, 'only-local'), pushed);
  assert.equal(pick(a, pushed.slice(0, 8)), pushed, '커밋 해시');
  assert.throws(() => pick(a, 'nope'));
});
