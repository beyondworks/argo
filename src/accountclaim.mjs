// 로컬(게스트) → 로그인 계정 전환 — "새 계정"이 아니라 **같은 사람의 이어짐**으로 처리한다
// (유건 지시 2026-08-21: 기존 데이터·크루 세팅 그대로 이어서 전환).
//
// 이어야 할 것 둘:
//  ① 회사 — 게스트 시절 만든 회사는 ownerId가 없다(주인 없음). 로그인 계정으로 귀속하면 목록·동기화가 이어진다.
//  ② 계정 스코프 러너 자격 — 온보딩에서 연결한 자격은 `.account-secrets-local.json`(로컬 스코프)에 있고,
//     로그인하면 스코프가 `<uid>`로 바뀌어 보이지 않았다 → 다음 회사 생성 때 시드가 안 되어 "연결이 사라진"
//     것처럼 보인다. uid 스코프로 복사한다(이미 있는 러너는 덮지 않는다. 로컬 파일은 남긴다 — 무해·되돌림 가능).
//     회사 폴더 안의 `.secrets.json`(크루 실행 자격)은 회사가 그대로이므로 손댈 것이 없다.
//
// 호출 지점: 로그인 완료 직후(기기 로그인·OAuth 콜백 — 게스트 모드였을 때만 자동) + 홈 배너의 수동 귀속.
// 보안 경계: 호출자가 루프백·실로그인·비워커를 이미 보장한다(라우트의 gate). 여기선 그 전제를 믿고 일만 한다.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { listCompanies } from './hub.mjs';
import { updateCompany, WS_ROOT } from './workspace.mjs';
import { clearGuestMode, guestModeOn } from './gueststate.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { nudgeSync } from './sync.mjs';
import { accountScope, loadRunnerCred, saveRunnerCred } from './runners/creds.mjs';
import { RUNNER_AUTH } from './runners/catalog.mjs';

/** 로컬 스코프 계정 자격 → uid 스코프 복사(덮어쓰기 없음). 반환: 복사한 러너 id 목록. */
export async function migrateLocalAccountCreds(uid) {
  if (!uid || uid === 'local' || uid === 'guest') return [];
  const from = accountScope('local'), to = accountScope(uid);
  const moved = [];
  for (const id of Object.keys(RUNNER_AUTH)) {
    const src = await loadRunnerCred(from, id).catch(() => null);
    if (!src) continue;
    const dst = await loadRunnerCred(to, id).catch(() => null);
    if (dst) continue; // 계정에 이미 연결된 러너 — 로컬 것이 덮지 않는다
    await saveRunnerCred(to, id, src.type, src.value);
    moved.push(id);
  }
  return moved;
}

/** 주인 없는 회사 전부 + 로컬 계정 자격을 이 계정으로. 반환 { claimed, names, creds }. */
export async function claimLocalToAccount(uid) {
  if (!uid || uid === 'local' || uid === 'guest') throw new Error('로그인 계정이 필요합니다');
  const orphans = (await listCompanies()).filter((c) => !c.ownerId);
  let claimed = 0;
  for (const c of orphans) { // 하나씩 — 도중 실패해도 이미 귀속된 회사는 유지(재시도 시 남은 것만)
    const after = await updateCompany(c.id, (cur) => (cur.ownerId ? {} : { ownerId: uid })); // 잠금 안에서 — 그새 생긴 주인은 덮지 않는다
    if (after.ownerId === uid) claimed++;
  }
  const creds = await migrateLocalAccountCreds(uid).catch(() => []);
  await clearGuestMode();
  await rm(join(WS_ROOT, CLAIM_PENDING_FILE), { force: true }).catch(() => {}); // 수동 귀속([이 계정에 연결])으로 끝나도 대기 표지를 지운다
  if (claimed) nudgeSync(); // 다음 사이클을 기다리지 않고 즉시 업로드
  return { claimed, names: orphans.map((c) => c.name), creds };
}

/* ─── 귀속 대기(0.1.121, 2026-10-30 고객 C) ───
   로그인 라우트(device/login·device/link·auth/callback)의 자동 귀속이 실패하면 종전에는 오류를 버렸다(auth/callback은 `.catch(() => {})`로 흔적도 없었다).
   이제 실패를 로그로 남기고 .claim-pending.json(uid·시각·오류)을 데이터 루트에 쓴다. 동기화 사이클(sync.mjs retryClaimIfPending)이 같은 계정으로
   로그인돼 있고 게스트 표시·주인 없는 회사가 남아 있을 때 retryPendingClaim으로 다시 한다. 표지는 이 안전한 경로들만 쓴다 — /auth/confirm(교차 사이트
   GET)은 쓰지 않으므로 공격자 세션으로 게스트 회사가 넘어가지 않는다(PR #1183 검수). 표지에는 계정 id·오류 문장만 있다(토큰 없음). */
export const CLAIM_PENDING_FILE = '.claim-pending.json';
export const CLAIM_RETRY_MS = 10 * 60_000;

/** 로그인 직후 자동 귀속 — 실패해도 로그인은 성공(종전 계약). 실패하면 로그 한 줄과 귀속 대기 표지를 남기고 { error }를 돌려준다. */
export async function claimOrDefer(uid, { now = Date.now() } = {}) {
  try {
    return await claimLocalToAccount(uid);
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    console.warn(`[argo] 게스트 회사 귀속 실패(로그인은 성공 — 동기화가 ${CLAIM_RETRY_MS / 60_000}분 뒤 다시 시도): ${error}`);
    await writeJsonAtomic(join(WS_ROOT, CLAIM_PENDING_FILE), { uid, at: now, error, nextAt: now + CLAIM_RETRY_MS }).catch(() => {});
    return { error };
  }
}

/** 귀속 대기 다시 시도 — 표지의 uid가 지금 세션 사용자와 같고 다시 시도할 때가 됐을 때만. 반환 { claimed } · { error } · { skipped }. */
export async function retryPendingClaim(uid, { now = Date.now() } = {}) {
  const f = join(WS_ROOT, CLAIM_PENDING_FILE);
  const p = await readJsonLenient(f, null).catch(() => null);
  if (!p || !uid || p.uid !== uid) return { skipped: p ? 'other-account' : 'none' }; // 다른 계정이 로그인했다 — 그 계정으로 넘기지 않는다
  if (!guestModeOn()) { await rm(f, { force: true }).catch(() => {}); return { skipped: 'no-guest' }; }
  if (Number(p.nextAt) > now) return { skipped: 'wait', error: p.error || 'pending' };
  try {
    const r = await claimLocalToAccount(uid);
    console.log(`[argo] 게스트 회사 귀속 다시 시도 성공 — ${r.claimed}개`);
    return { claimed: r.claimed };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    console.warn(`[argo] 게스트 회사 귀속 다시 시도 실패(${CLAIM_RETRY_MS / 60_000}분 뒤 다시): ${error}`);
    await writeJsonAtomic(f, { ...p, error, nextAt: now + CLAIM_RETRY_MS, tries: (Number(p.tries) || 0) + 1 }).catch(() => {});
    return { error };
  }
}
