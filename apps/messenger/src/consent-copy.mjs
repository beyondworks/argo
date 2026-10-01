// AI 이용 동의 — 설정 행이 쓸 문구 키. 조직이 하나도 없는 계정(개인 공간만)에는 "이 조직" 문장이 맞지 않는다.
export function aiConsentCopy({ consented, hasOrg }) {
  const suffix = hasOrg ? '' : '.personal';
  return {
    status: `set.aiConsent.${consented ? 'on' : 'off'}${suffix}`,
    revokeDesc: consented ? `set.aiConsent.revoke.${hasOrg ? 'org' : 'personal'}` : null,
  };
}
