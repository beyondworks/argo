// 회사 정보 읽기 창구 — 견적서·계약서 서식(공급자·을)·서명 요청 메일이 여기 하나에서 읽는다(인트라넷 lib/docgen/render.ts SUPPLIER 하드코딩 대체).
// 정본은 트랙 C(feat/office-company)의 src/core/company.js getCompanyProfile(space). 그 파일이 있으면(병합 뒤) 그것을 읽고,
// 없으면(이 브랜치 단독) 예시 데이터 모드는 SAMPLE_COMPANY, 로그인 모드는 공간 이름만 채운 빈 정보(서식은 빈 칸으로 그린다).
// import.meta.glob은 파일이 없으면 빈 목록이라 빌드가 깨지지 않는다. 이 파일은 지연 로드 화면(견적·계약)만 가져온다.
import { getMode, SPACES, ME } from '../core/session.js';

import { SAMPLE_COMPANY, normalizeCompany, fromProfile } from './company-model.js';

const trackC = import.meta.glob('../core/company.js');

let source = null;
/** 다른 읽기 함수를 꽂는다(테스트·다른 화면) — fn(space) → Promise<원본|null>. null을 넘기면 기본으로 돌아간다 */
export function setCompanySource(fn) { source = typeof fn === 'function' ? fn : null; }

async function fromTrackC(space) {
  const load = trackC['../core/company.js'];
  if (!load) return undefined;
  const m = await load();
  return m.getCompanyProfile ? fromProfile(await m.getCompanyProfile(space)) : undefined;
}

/** 이 공간의 회사 정보(서식용으로 정리된 값) */
export async function getCompanyInfo(space) {
  const sp = SPACES.find((s) => s.key === space);
  const fallback = space === 'me' ? ME.name : sp?.name ?? '';
  let raw = null;
  try {
    raw = source ? await source(space) : await fromTrackC(space);
    if (raw === undefined) raw = getMode() === 'sample' ? SAMPLE_COMPANY[space] ?? null : null;
  } catch { raw = null; }
  return normalizeCompany(raw, fallback);
}
