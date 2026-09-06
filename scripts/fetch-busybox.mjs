#!/usr/bin/env node
// busybox-w32 UTF-8 빌드를 해시 고정으로 내려받는다 — 윈도우 앱의 Bash 도구 기본 실행기(src/engine/shell-backend.mjs).
//   빌드: scripts/stage-sidecar.mjs가 resources/server/bin/에 · 테스트: test.yml(windows)이 레포 루트 bin/에.
// 해시 갱신 절차: 새 FRP 릴리스를 받아 sha256을 확인하고 아래 상수를 바꾼다(불일치·다운로드 실패는 빌드 중단 — 조용히 cmd.exe 폴백본이 나가지 않게).
// ARGO_BUSYBOX_PATH=<로컬 파일>이면 다운로드 대신 그 파일을 쓴다(오프라인 빌드) — 해시는 똑같이 검사한다.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUSYBOX_URL = 'https://frippery.org/files/busybox/busybox64u.exe';
export const BUSYBOX_SHA256 = '6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c'; // BusyBox v1.38.0-FRP-6075-g169694ebd (2026-05-06), 719,360B
export const BUSYBOX_FILE = 'busybox64u.exe';

export async function fetchBusybox(destDir, { url = BUSYBOX_URL, sha256 = BUSYBOX_SHA256, localPath = process.env.ARGO_BUSYBOX_PATH, fetchImpl = globalThis.fetch } = {}) {
  let buf;
  if (localPath) buf = readFileSync(localPath);
  else { const r = await fetchImpl(url); if (!r.ok) throw new Error(`busybox 다운로드 실패: HTTP ${r.status} ${url}`); buf = Buffer.from(await r.arrayBuffer()); }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha256) throw new Error(`busybox 해시 불일치 — 기대 ${sha256}, 실제 ${got} (${localPath || url}). 새 릴리스면 fetch-busybox.mjs의 상수를 갱신하고 시뮬을 다시 돌릴 것`);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, BUSYBOX_FILE); writeFileSync(dest, buf);
  return { dest, bytes: buf.length, sha256: got };
}

if (process.argv[1] && /fetch-busybox\.mjs$/.test(process.argv[1])) {
  const dir = process.argv[2] || 'bin';
  const r = await fetchBusybox(dir); console.log(`[busybox] ${r.dest} ${r.bytes}B sha256=${r.sha256}`);
}
