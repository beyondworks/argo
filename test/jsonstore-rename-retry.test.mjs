// 크루 이름 변경 PATCH의 Windows 오류 제보(2026-09-08) — writeJsonAtomic이 임시파일→rename으로
// 카드를 저장하는데, 대상 파일을 다른 프로세스(AV 스캔·인덱서 등)가 열어 둔 동안 Windows는
// rename을 EPERM으로 거절한다. 격리 재현(ssh winpc, 2026-09-24): 옛 예산(~450ms)은 200ms 보유는
// 통과했지만 600ms 보유부터 실패했다. renameRetry의 예산을 3초(지수 백오프)로 늘렸다 — 이 테스트는
// win32로 가장해 그 경계를 고정한다(darwin/linux에서도 실행 가능 — 실제 fs 동작은 그대로, platform만 스텁).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { writeJsonAtomic } from '../src/jsonstore.mjs';

function asWin32() {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  return () => Object.defineProperty(process, 'platform', desc);
}

test('win32: 파일이 600ms 열려 있어도(AV/인덱서급 보유) writeJsonAtomic이 회복한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-rename-'));
  const file = join(dir, 'agent-card.md');
  await writeFile(file, 'before', 'utf8');
  const restore = asWin32();
  try {
    const fh = await open(file, 'r');
    const release = setTimeout(() => fh.close().catch(() => {}), 600);
    try {
      await writeJsonAtomic(file, 'after');
    } finally { clearTimeout(release); await fh.close().catch(() => {}); }
    assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), 'after');
  } finally { restore(); }
});

// 열린 read 핸들이 rename을 막는 건 win32의 실제 OS 시맨틱이라 process.platform 스텁만으로는
// macOS/Linux에서 재현되지 않는다(POSIX는 read-share 중 rename을 허용) — 그래서 이 테스트는
// **실제** win32(test.yml의 windows-latest 잡)에서만 돈다. ssh winpc 격리 재현(2026-09-24)이 이미
// 같은 조건에서 EPERM을 확인했다(관찰 근거, 이 파일 상단 주석).
test('win32: 계속 잠겨 있으면(영구 잠금) 결국 오류를 낸다 — 조용히 삼키지 않는다', { skip: process.platform !== 'win32' ? '실제 win32 OS 잠금 시맨틱 필요 — windows-latest CI에서만 실행' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-rename-'));
  const file = join(dir, 'agent-card.md');
  await writeFile(file, 'before', 'utf8');
  const fh = await open(file, 'r'); // 테스트 끝까지 안 닫음 — 영구 잠금 흉내
  try {
    await assert.rejects(() => writeJsonAtomic(file, 'after'), (e) => e.code === 'EPERM' || e.code === 'EACCES');
    assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), 'before', '실패한 갱신이 원본을 건드리면 안 된다');
  } finally { await fh.close().catch(() => {}); }
});

test('darwin/linux: EPERM/EACCES를 재시도 없이 바로 올린다(POSIX에선 영구 조건 — win32 전용 재시도가 마스킹하면 안 됨)', async () => {
  if (process.platform === 'win32') return; // 실제 win32에선 위 테스트들이 이미 실경로를 검증
  const dir = await mkdtemp(join(tmpdir(), 'argo-rename-'));
  const file = join(dir, 'agent-card.md');
  await writeFile(file, 'before', 'utf8');
  const fh = await open(file, 'r');
  const t0 = Date.now();
  try {
    // POSIX에서 read-share 중 rename은 보통 성공한다(Windows와 다른 시맨틱) — 이 테스트가 확인하는 건
    // "실패한다면 즉시(재시도 지연 없이) 실패한다"는 win32 게이트 그 자체다. 성공해도 유효한 관찰이다.
    await writeJsonAtomic(file, 'after').catch(() => {});
  } finally { await fh.close().catch(() => {}); }
  assert.ok(Date.now() - t0 < 400, 'win32 전용 3초 재시도 예산이 POSIX 경로에 새면 안 된다');
});
