// 명패 '사용자' 줄의 값(M10) — company.owner 저장 값은 그대로 두고 표시만 정한다.
// 회사를 만들 때 이름을 받지 않으면 owner에 기본값 'captain'이 저장된다(api/companies/route.js, bin/argo.mjs). 그 값을 그대로 보이면
// 명패에 영어 'captain'이 뜬다. 기본값·빈 값이면 사용자 이름(있으면), 없으면 '—'. 사용자가 직접 적은 이름·'회사 노드'는 그대로 보인다.
import { OWNER_PLACEHOLDERS } from '../../src/legacy-terms.mjs';

export function nameplateOwner(owner, userName = null) {
  const v = typeof owner === 'string' ? owner.trim() : '';
  if (v && !OWNER_PLACEHOLDERS.includes(v)) return v;
  const name = typeof userName === 'string' ? userName.trim() : '';
  return name || '—';
}
