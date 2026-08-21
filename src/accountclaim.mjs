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
import { listCompanies } from './hub.mjs';
import { updateCompany } from './workspace.mjs';
import { clearGuestMode } from './gueststate.mjs';
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
    await updateCompany(c.id, { ownerId: uid });
    claimed++;
  }
  const creds = await migrateLocalAccountCreds(uid).catch(() => []);
  await clearGuestMode();
  if (claimed) nudgeSync(); // 다음 사이클을 기다리지 않고 즉시 업로드
  return { claimed, names: orphans.map((c) => c.name), creds };
}
