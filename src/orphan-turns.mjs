// 고아 턴 스위퍼 — 서버가 턴 실행 중에 죽으면(재배포·크래시·강제종료) beginTurn이 선저장한 지시가
// awaiting인 채 영영 남고, 사용자에겐 "진행 중이던 업무가 흔적 없이 사라진" 무언 실패로 보인다
// (실사고 2026-08-28 00:48: 상주 재배포가 페퍼 턴을 죽여 응답·실패기록·이벤트 전무 — 유건 원칙
// "실패 자체가 있으면 안 되고, 나더라도 보여야 한다" 위반). 부팅 시 한 번 쓸어 정직한 실패
// 표시(m.failed — UI가 사유+재전송을 그림)로 전환한다.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT, paths } from './workspace.mjs';
import { readJsonLenient, writeJsonAtomic } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { exists } from './runners/shared.mjs';
import { getTurnStatus } from './turn-status.mjs';
import { loadCompany } from './workspace.mjs';

// 스레드 파일명 — 크루 DM(<slug>.json)·회의실(room-*.json)만. 아카이브(_ 접두)·상태(.status.json)·
// 휴지통(.trash)은 제외(thread.mjs ANY_ARCH_ID·sync isThread와 같은 경계).
const THREAD_RE = /^[a-z0-9][a-z0-9-]*\.json$/;

/** 방금 부팅한 프로세스에는 실행 중인 턴이 없다 — 그런데 awaiting 지시가 남아 있으면 이전 프로세스가
    턴 도중 죽은 것이다. 단 (a) 다른 프로세스가 같은 루트를 서빙 중일 수 있어 **신선한 상태 파일이
    있으면 건너뛰고**(getTurnStatus 2분 창), (b) 방금 도착한 지시(60초 미만)도 경합 회피로 건너뛴다.
    반환: 표시 전환한 턴 수. (export: 테스트용) */
export async function sweepOrphanTurns({ now = Date.now() } = {}) {
  const root = WS_ROOT; // paths()와 같은 전역 기준 — 이중 루트 금지(테스트는 ARGO_ROOT env 선설정 후 임포트)
  let marked = 0;
  const companies = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const c of companies) {
    if (!c.isDirectory() || c.name.startsWith('.')) continue;
    const wsId = c.name;
    if (!await exists(join(root, wsId, 'company.json'))) continue;
    const chatsDir = paths(wsId).chats;
    const files = await readdir(chatsDir).catch(() => []);
    for (const f of files) {
      if (!THREAD_RE.test(f)) continue;
      const slug = f.replace(/\.json$/, '');
      const p = join(chatsDir, f);
      const t = await readJsonLenient(p, null);
      if (!t?.messages?.some((m) => m.awaiting && m.turnId)) continue;
      // 다른 살아 있는 프로세스가 이 크루의 턴을 돌리는 중이면 손대지 않는다(상태 파일 2분 신선 창)
      if (await getTurnStatus(wsId, slug)) continue;
      await withLock(`thread:${wsId}:${slug}`, async () => {
        const cur = await readJsonLenient(p, null); // 락 안 재독 — 경합 시 최신 기준
        if (!cur?.messages) return;
        let touched = false;
        for (const m of cur.messages) {
          if (!m.awaiting || !m.turnId) continue;
          if (now - (m.ts ?? 0) < 60_000) continue; // 방금 지시 — 경합 회피
          delete m.awaiting;
          const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
          m.failed = lang === 'en'
            ? 'The server restarted while this turn was running, so it was interrupted. Please resend.'
            : '이 지시를 실행하던 중 서버가 재시작되어 중단됐습니다. 다시 보내 주세요.';
          touched = true; marked += 1;
        }
        if (touched) await writeJsonAtomic(p, cur);
      }).catch(() => {}); // 스위퍼는 베스트에포트 — 한 스레드 실패가 부팅·다른 스레드를 막지 않는다
    }
  }
  if (marked) console.warn(`[argo] 고아 턴 ${marked}건 표시 전환 — 이전 프로세스가 턴 도중 종료됨`);
  return marked;
}
