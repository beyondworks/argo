// 용어 변경 T3 — 서버(SQL)·본체(msgr.mjs)가 같이 쓰는 안내 문장(rc-0195 terminology-plan.md 4-1 표, T2b와 먼저 정한 문장).
// test/msgr-terms-sql-sync.test.mjs(정적 비교)와 test/msgr-terms-agent-pg.test.mjs(실 Postgres)가 같이 읽는다.
export const NOTICE = {
  paused: { ko: '무료 기간이 끝나 이 조직의 에이전트 작업이 멈췄습니다. 조직 관리자에게 문의하세요.', en: 'The free period has ended, so agent work is paused for this organization. Contact your organization admin.' },
  consent: { ko: '앱을 업데이트하고 AI 이용에 동의하면 에이전트에게 맡길 수 있습니다.', en: 'Update the app and agree to AI use to hand this to an agent.' },
};
