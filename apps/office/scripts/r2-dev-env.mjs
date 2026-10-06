// 로컬 실측(scripts/r2-smoke.mjs)·실제 R2 한 바퀴(test/office-r2-live.roundtrip.mjs)는 개발 버킷(argo-office-dev)만 쓴다(총괄 10/2).
// 레포 루트 .env.local의 R2_OFFICE_DEV_BUCKET·R2_OFFICE_DEV_ACCESS_KEY_ID·R2_OFFICE_DEV_SECRET_ACCESS_KEY를 앱이 읽는 이름(R2_OFFICE_*)으로 옮긴다.
// 운영 버킷 이름(argo-office)이거나, 개발 이름에 운영 키가 들어 있거나, 개발 변수가 없으면 거절한다 — 운영 변수로 대신 넘어가지 않는다. 값은 출력하지 않는다.
const PROD_BUCKET = 'argo-office';

export function devR2Env(env) {
  const bucket = String(env.R2_OFFICE_DEV_BUCKET ?? '').trim(), id = env.R2_OFFICE_DEV_ACCESS_KEY_ID, secret = env.R2_OFFICE_DEV_SECRET_ACCESS_KEY;
  if (!bucket || !id || !secret || !env.R2_ENDPOINT) throw new Error('R2_OFFICE_DEV_BUCKET·R2_OFFICE_DEV_ACCESS_KEY_ID·R2_OFFICE_DEV_SECRET_ACCESS_KEY·R2_ENDPOINT가 필요하다(값은 출력하지 않음)');
  if (bucket.toLowerCase() === PROD_BUCKET) throw new Error('운영 버킷(argo-office)으로는 돌리지 않는다 — 개발 버킷을 쓰라');
  if ((env.R2_OFFICE_ACCESS_KEY_ID && id === env.R2_OFFICE_ACCESS_KEY_ID) || (env.R2_OFFICE_SECRET_ACCESS_KEY && secret === env.R2_OFFICE_SECRET_ACCESS_KEY)) throw new Error('개발 이름에 운영 키가 들어 있다 — 거절');
  return { R2_ENDPOINT: env.R2_ENDPOINT, R2_OFFICE_BUCKET: bucket, R2_OFFICE_ACCESS_KEY_ID: id, R2_OFFICE_SECRET_ACCESS_KEY: secret };
}
