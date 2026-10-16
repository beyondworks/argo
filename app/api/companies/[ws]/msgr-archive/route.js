// 메신저 기록 옮기기 — 설정 화면의 진행률·완료·실패 표시와 재시도(src/msgr-archive-run.mjs). 받기는 기기 세션(사용자 JWT)으로만 한다.
// GET: 로컬 상태 파일 + 중단 스위치 캐시(10분에 한 번만 RPC — 진행 중 2초 폴은 로컬 파일만 읽어 Supabase 요청 0). POST { action: 'start' }: 스위치가 켜져 있을 때만 시작·이어 받기.
import { guardCompany, csrfDenied, requestLang } from '../../../../auth.mjs';
import { apiError } from '../../../../apimsg.mjs';
import { sessionClient } from '../../../../../src/gateway/msgr.mjs';
import { loadCompany } from '../../../../../src/workspace.mjs';
import { pauseState, cachedPause } from '../../../../../src/msgr-archive.mjs';
import { archiveStatus, startArchive } from '../../../../../src/msgr-archive-run.mjs';

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const c = await sessionClient().catch(() => null);
  if (!c) return Response.json({ signedIn: false, paused: cachedPause()?.paused === true, status: 'none' });
  // ?local=1 — 회사 화면 머리의 완료 안내가 쓴다. 스위치는 읽은 값만(RPC 0회) — 앱 시작 확인·설정 화면이 이미 읽는다
  const local = new URL(req.url).searchParams.get('local') === '1';
  const pause = local ? (cachedPause() ?? { paused: false, since: null }) : await pauseState(c.client);
  return Response.json({ signedIn: true, paused: pause.paused, since: pause.since, ...(await archiveStatus(c.uid, ws)) });
}

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  const c = await sessionClient().catch(() => null);
  if (!c) return apiError('msgr_archive_signin', lang);
  const company = await loadCompany(ws).catch(() => null);
  if (company?.ownerId !== c.uid) return apiError('msgr_archive_owner', lang); // 남의 회사 폴더에 내 메신저 기록을 두지 않는다
  const pause = await pauseState(c.client, { force: true });
  if (!pause.paused) return apiError('msgr_archive_not_paused', lang);
  const r = await startArchive({ c, ws });
  return Response.json({ started: !!r.started, running: !!r.running, ...(await archiveStatus(c.uid, ws)) });
}
