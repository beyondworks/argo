#!/usr/bin/env node
// busybox-w32 UTF-8 빌드를 해시 고정으로 내려받는다 — 윈도우 앱의 Bash 도구 기본 실행기(src/engine/shell-backend.mjs).
//   빌드: scripts/stage-sidecar.mjs가 resources/server/bin/에 · 테스트: test.yml(windows)이 레포 루트 bin/에.
// 해시 갱신 절차: 새 FRP 릴리스를 받아 sha256을 확인하고 아래 상수를 바꾼다(불일치·다운로드 실패는 빌드 중단 — 조용히 cmd.exe 폴백본이 나가지 않게).
// ARGO_BUSYBOX_PATH=<로컬 파일>이면 다운로드 대신 그 파일을 쓴다(오프라인 빌드) — 해시는 똑같이 검사한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 레포 동봉본 위치 — 같은 해시의 파일을 vendor/에 둔다(해시 검증은 똑같이 거친다). 갱신 절차: 새 FRP 릴리스 다운로드 → sha256 확인 → 상수·파일 함께 교체. */
export const VENDOR_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'vendor');

export const BUSYBOX_URL = 'https://frippery.org/files/busybox/busybox-w64u-FRP-6075-g169694ebd.exe'; // 판 고정 파일명(롤링 busybox64u.exe는 upstream 릴리스 때 해시가 바뀐다 — 1R L1)
/** 대응 소스(GPLv2 §3) — 발행 드릴이 릴리스 자산에 함께 올린다: `node scripts/fetch-busybox.mjs source <dir>` */
export const BUSYBOX_SRC_URL = 'https://frippery.org/files/busybox/busybox-w32-FRP-6075-g169694ebd.tgz';
export const BUSYBOX_SRC_SHA256 = '44401413c86a839deeec3eba088af244a1594f18ff9fd0622811100e4cc2e7b4'; // 3,690,927B
export const BUSYBOX_SRC_FILE = 'busybox-w32-FRP-6075-g169694ebd.tgz';
export const BUSYBOX_SHA256 = '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c'; // BusyBox v1.38.0-FRP-6075-g169694ebd (2026-05-06), 675,840B
export const BUSYBOX_FILE = 'busybox64u.exe';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** 다운로드 — 배포 서버 한 곳(frippery.org)에 의존하므로 일시 장애(연결 타임아웃, CI 실측 2026-09-06)는 재시도로 흡수한다: attempts회, 시도당 timeoutMs, 2배 대기. */
async function download(url, { fetchImpl, attempts = 3, timeoutMs = 20_000, waitMs = 2_000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; if (i < attempts) await new Promise((res) => setTimeout(res, waitMs * 2 ** (i - 1))); }
  }
  throw new Error(`busybox 다운로드 실패(${attempts}회): ${String(last?.message || last)} ${url} — 오프라인이면 ARGO_BUSYBOX_PATH=<파일>`);
}
export async function fetchBusybox(destDir, { url = BUSYBOX_URL, sha256 = BUSYBOX_SHA256, localPath = process.env.ARGO_BUSYBOX_PATH, vendorDir = VENDOR_DIR, fetchImpl = globalThis.fetch, attempts, timeoutMs, waitMs } = {}) {
  const dest = join(destDir, BUSYBOX_FILE);
  // 이미 같은 해시의 파일이 있으면 그대로(CI 캐시·재빌드 — 배포 서버를 다시 두드리지 않는다)
  if (existsSync(dest)) { const cur = readFileSync(dest); if (sha(cur) === sha256) return { dest, bytes: cur.length, sha256, cached: true }; }
  // 출처 순서: ARGO_BUSYBOX_PATH → 레포 동봉본(vendor/ — 빌드·CI가 배포 서버에 의존하지 않게: frippery.org가 GitHub 러너에서 연결 타임아웃·fetch failed로 두 번 죽었다, 2026-09-06) → URL(동봉본이 없을 때만)
  const vendored = join(vendorDir, BUSYBOX_FILE);
  const buf = localPath ? readFileSync(localPath) : existsSync(vendored) ? readFileSync(vendored) : await download(url, { fetchImpl, attempts, timeoutMs, waitMs });
  const got = sha(buf);
  if (got !== sha256) throw new Error(`busybox 해시 불일치 — 기대 ${sha256}, 실제 ${got} (${localPath || url}). 새 릴리스면 fetch-busybox.mjs의 상수를 갱신하고 시뮬을 다시 돌릴 것`);
  mkdirSync(destDir, { recursive: true }); writeFileSync(dest, buf);
  return { dest, bytes: buf.length, sha256: got, cached: false };
}

export async function fetchBusyboxSource(destDir, { url = BUSYBOX_SRC_URL, sha256 = BUSYBOX_SRC_SHA256, fetchImpl = globalThis.fetch, attempts, timeoutMs, waitMs } = {}) {
  const buf = await download(url, { fetchImpl, attempts, timeoutMs, waitMs }); const got = sha(buf);
  if (got !== sha256) throw new Error(`busybox 소스 해시 불일치 — 기대 ${sha256}, 실제 ${got} (${url})`);
  mkdirSync(destDir, { recursive: true }); const dest = join(destDir, BUSYBOX_SRC_FILE); writeFileSync(dest, buf);
  return { dest, bytes: buf.length, sha256: got };
}

if (process.argv[1] && /fetch-busybox\.mjs$/.test(process.argv[1])) {
  if (process.argv[2] === 'source') { const r = await fetchBusyboxSource(process.argv[3] || 'bin'); console.log(`[busybox-src] ${r.dest} ${r.bytes}B sha256=${r.sha256}`); }
  else { const r = await fetchBusybox(process.argv[2] || 'bin'); console.log(`[busybox] ${r.dest} ${r.bytes}B sha256=${r.sha256}${r.cached ? ' (캐시)' : ''}`); }
}
