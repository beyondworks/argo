// 회사 정보·직원 명부 데이터(트랙 C, 유건 10/2) — 서버 office_company_* · office_people_* 함수로만(표를 직접 읽는 길은 없다).
// 부하: 화면을 열 때 1회 읽기(30초 안에 받은 것은 다시 받지 않음), 저장을 누를 때만 쓰기. 폴링 없음.
// 예시 모드(서버 설정 없음)는 data/company-sample.js를 화면 메모리에서 읽고 쓴다.
//
// ── 견적·계약 서식(트랙 A)이 읽는 API ──
//   import { getCompanyProfile } from '../core/company.js';
//   const p = await getCompanyProfile(space);   // { name, regName, ceo, bizNo, corpNo, openDate, address, bizType, bizItem, taxEmail,
//                                               //   manager, phone, fax, email, website, seal, logo(그림 주소 — data:image·https, 없으면 ''),
//                                               //   accounts: [{ label, value }], missing: [key…] }
//   - 내 공간('me')은 회사가 없어 빈 값(missing = 서식 칸 전부)을 돌려준다. 읽지 못하면(권한·네트워크) 오류를 던진다.
//   - 화면에서 쓰려면 useCompany(space) → { data: { role, items, deleted }, profile, error, loading, reload }
import { useCallback, useEffect, useState } from 'react';
import { configured } from './supabase.js';
import { rpc, orgOf } from './tasks.js';
import { canManage, ME } from './session.js';
import { companyProfile } from './company-model.js';
import { sampleCompany, sampleCompanyWrite, samplePeople, samplePeopleWrite } from '../data/company-sample.js';

const ERRORS = { company_forbidden: 'permission', company_input: 'input', company_key: 'key', company_conflict: 'conflict', company_not_found: 'missing', company_limit: 'limit', task_signin: 'signin' };
export const companyError = (e) => `company.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'permission' : 'failed')}`;

const cache = new Map(); // `${kind}:${space}` → { at, data }
const fresh = (k) => { const c = cache.get(k); return c && Date.now() - c.at < 30e3 ? c.data : null; };

async function read(kind, space, again) {
  const k = `${kind}:${space}`;
  if (!again && fresh(k)) return fresh(k);
  const org = orgOf(space);
  if (space === 'me' || (configured && !org)) return kind === 'company' ? { role: 'member', items: [], deleted: [] } : { role: 'member', me: ME.id, people: [] };
  const manager = canManage(space);
  const data = configured
    ? await rpc(kind === 'company' ? 'office_company_read' : 'office_people_read', { p_org: org })
    : (kind === 'company' ? sampleCompany(space, manager) : samplePeople(space, manager, ME.id));
  cache.set(k, { at: Date.now(), data });
  return data;
}
export const loadCompany = (space, { again } = {}) => read('company', space, again);
export const loadPeople = (space, { again } = {}) => read('people', space, again);

/** 견적·계약 서식용 — 위 설명 참고 */
export async function getCompanyProfile(space) {
  return companyProfile((await loadCompany(space)).items);
}

async function write(kind, space, action, data) {
  const org = orgOf(space);
  try {
    const r = configured ? await rpc(kind === 'company' ? 'office_company_write' : 'office_people_write', { p_org: org, p_action: action, p_data: data })
      : (kind === 'company' ? sampleCompanyWrite(space, action, data) : samplePeopleWrite(space, action, data));
    cache.delete(`${kind}:${space}`);
    return r;
  } catch (e) { throw new Error(companyError(e)); }
}
export const companyWrite = (space, action, data) => write('company', space, action, data);
export const peopleWrite = (space, action, data) => write('people', space, action, data);

function useLoad(loader, space) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async (again) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try { setState({ data: await loader(space, { again }), error: null, loading: false }); }
    catch (e) { setState({ data: null, error: companyError(e), loading: false }); }
  }, [space]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(false); }, [load]);
  return { ...state, reload: () => load(true) };
}
export function useCompany(space) {
  const s = useLoad(loadCompany, space);
  return { ...s, profile: s.data ? companyProfile(s.data.items) : null };
}
export const usePeople = (space) => useLoad(loadPeople, space);
