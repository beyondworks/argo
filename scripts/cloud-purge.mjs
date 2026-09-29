#!/usr/bin/env node
// R4(2026-09-29) 클라우드 사본 정리 — Pro가 아닌 계정의 companies 버킷 사본(<uid>/…)을 30일 보관 후 삭제.
//
// 대상 판정은 이 스크립트가 하지 않는다 — DB의 plan_purge_candidates()(마이그레이션
// 20260929110000, service_role 전용)가 SQL로 계산한 purge_after(uid) 결과를 그대로 받는다. 판정
// 로직이 여기 또 있으면 둘이 갈리는 순간 회귀다(is_pro_for·purge_after가 유일한 정본).
//
// 기본은 **dry-run**이다 — 대상 계정별 폴더 수·파일 수·바이트만 세어 보고한다. 실제 삭제는
// --execute와 확인용 --confirm=<대상 수>를 **둘 다** 줄 때만 실행한다(그 사이 대상이 늘거나 줄면
// 사람이 다시 보게 하려는 의도 — 조용히 더 많이/적게 지우는 사고를 막는다).
//
// 제외(지우지 않는다 — 사용자 자료가 아니라 동기화 운영 인프라):
//   _device-lease.json — 기기 리더 선출 파일(<uid> 바로 아래 파일, id 있는 leaf).
//     20260723001629_companies_sync_pro_gate.sql가 이 파일만 Pro 게이트에서 예외로 두는 것과 같은
//     근거: 결제와 무관한 동기화 인프라라서, 삭제 대상에도 넣지 않는다.
//   .tg-claims/, .tg-claims-state.json — 텔레그램 토큰 클레임 상태(src/sync.mjs CLAIM_DIR).
//   .tombstones — 삭제 전파 마커.
//   (점 접두 폴더는 src/cloudexport.mjs도 "동기화 인프라 — 자료 아님"으로 이미 제외하는 것과 같은 정의.)
//   이 넷을 지우면 계정이 나중에 다시 Pro가 되거나 재로그인할 때 리더 선출·토큰 클레임·툼스톤
//   판정이 깨질 수 있다 — 지워서 얻는 용량 이득은 미미하고 위험만 있다.
//
// 사용:
//   node scripts/cloud-purge.mjs                        # dry-run — 대상 목록·용량만 보고
//   node scripts/cloud-purge.mjs --execute --confirm=3  # 대상이 정확히 3명일 때만 실제 Storage 삭제
// env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env.local 자동 로드)
//
// ⚠ 이 스크립트는 test/cloud-purge.test.mjs의 로컬 가짜 storage/rpc로만 확인했다 — 라이브에서
// 실행하지 않았다(CLAUDE.md DB 위생 절대 규칙: 정리는 대상 목록·승인 뒤에만, 기존 데이터 보존 우선).

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUCKET = 'companies';
const INFRA_LEAF = new Set(['_device-lease.json']); // <uid> 바로 아래 leaf 파일 — id 있는 항목

const isInfraFolder = (name) => name.startsWith('.'); // .tg-claims, .tombstones 등 — 점 접두 전부 제외

/** prefix 아래 전부(파일 leaf 포함) 재귀 열거 — cloudexport.mjs collectFiles와 같은 list 계약
    (list(prefix, {offset}) → {data:[{name, id, metadata?}]}, id 있으면 파일). 코어는 storage 주입이라
    실 Supabase 없이 테스트된다(export: 테스트용). */
export async function collectDeletable(storage, uid) {
  const files = []; // { key, size }
  const top = await listAll(storage, uid);
  const folders = top.filter((e) => !e.id && !isInfraFolder(String(e.name)));
  for (const f of folders) {
    await walk(storage, `${uid}/${f.name}`, files);
  }
  return { folders: folders.map((f) => String(f.name)), files };
}

async function walk(storage, prefix, out) {
  for (const e of await listAll(storage, prefix)) {
    const name = String(e.name);
    if (e.id) out.push({ key: `${prefix}/${name}`, size: Number(e.metadata?.size ?? 0) });
    else await walk(storage, `${prefix}/${name}`, out);
  }
}

async function listAll(storage, prefix) {
  const out = []; let offset = 0;
  for (;;) {
    const { data, error } = await storage.list(prefix, { limit: 1000, offset });
    if (error) throw new Error(error.message ?? String(error));
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length === 0) return out; // 종료는 빈 배치로만 판정(서버 캡 대응, cloudexport와 동일 규약)
    offset += batch.length;
  }
}

/** 후보 1명의 보고 행 계산(순수 코어 — export: 테스트용). */
export async function reportFor(storage, candidate) {
  const { folders, files } = await collectDeletable(storage, candidate.user_id);
  const bytes = files.reduce((s, f) => s + f.size, 0);
  return { userId: candidate.user_id, purgeAfter: candidate.purge_after, folders: folders.length, files: files.length, bytes, keys: files.map((f) => f.key) };
}

/** 전체 실행 — sb(rpc·storage 인터페이스 주입)만 있으면 실 Supabase 없이 테스트된다. execute=true면
    확인된 키를 storage.remove()로 지운다(500개씩 배치 — Storage API 상한). */
export async function runCloudPurge({ sb, execute = false, confirm = null, log = console.log }) {
  const { data: candidates, error } = await sb.rpc('plan_purge_candidates');
  if (error) throw new Error(error.message ?? String(error));
  const rows = candidates ?? [];
  const storage = sb.storage.from(BUCKET);
  const reports = [];
  for (const c of rows) reports.push(await reportFor(storage, c));

  log(`대상 ${reports.length}명 (dry-run=${!execute})`);
  for (const r of reports) {
    log(`  ${r.userId} · 폴더 ${r.folders}개 · 파일 ${r.files}개 · ${(r.bytes / 1_048_576).toFixed(1)}MB · purge_after=${r.purgeAfter}`);
  }

  if (!execute) return { reports, deleted: false };
  if (confirm !== reports.length) {
    throw new Error(`--confirm(${confirm})이 실제 대상 수(${reports.length})와 다릅니다 — 그 사이 바뀐 대상이 있는지 다시 확인하세요. 삭제하지 않았습니다.`);
  }
  for (const r of reports) {
    // 목록을 뽑은 뒤 결제한 사용자를 지우지 않도록 계정마다 삭제 직전에 다시 확인한다(보안 검수 H2).
    // 재확인 실패는 삭제 근거가 없으므로 멈춘다.
    const { data: proNow, error: proErr } = await sb.rpc('is_pro_for', { p_uid: r.userId });
    if (proErr) throw new Error(`${r.userId} Pro 재확인 실패: ${proErr.message ?? proErr} — 이 계정부터 삭제하지 않았습니다.`);
    if (proNow === true) { log(`  건너뜀: ${r.userId} (삭제 직전 Pro 확인)`); continue; }
    const keys = r.keys;
    for (let i = 0; i < keys.length; i += 500) {
      const { error: rmErr } = await storage.remove(keys.slice(i, i + 500));
      if (rmErr) throw new Error(`${r.userId} 삭제 실패: ${rmErr.message ?? rmErr}`);
    }
    log(`  삭제 완료: ${r.userId} (${keys.length}개 객체)`);
  }
  return { reports, deleted: true };
}

// ── CLI 진입점 — 실 Supabase 연결. 테스트는 runCloudPurge를 직접 호출(위 export). ──
async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = join(ROOT, '.env.local');
  if (existsSync(envFile)) {
    for (const l of readFileSync(envFile, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  }
  const { NEXT_PUBLIC_SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
  if (!URL_ || !KEY) {
    console.error('NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY가 필요합니다(.env.local 또는 env)');
    process.exit(2);
  }
  const req = createRequire(join(ROOT, 'package.json'));
  const { createClient } = req('@supabase/supabase-js');
  const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

  const execute = process.argv.includes('--execute');
  const confirmArg = process.argv.find((a) => a.startsWith('--confirm='));
  const confirm = confirmArg ? Number(confirmArg.slice('--confirm='.length)) : null;
  if (execute && !Number.isInteger(confirm)) {
    console.error('--execute에는 --confirm=<대상 수>가 함께 필요합니다(예: --execute --confirm=3)');
    process.exit(2);
  }
  try {
    await runCloudPurge({ sb, execute, confirm });
  } catch (e) {
    console.error('[cloud-purge] 실패:', e?.message ?? e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
