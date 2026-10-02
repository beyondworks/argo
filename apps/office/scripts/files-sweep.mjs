// 오피스 저장소 정리를 화면·Vercel 없이 직접 돌린다(분리 검수 MEDIUM 1) — 예: VPS cron `17 4 * * * node apps/office/scripts/files-sweep.mjs`.
// 하는 일은 api/files sweep(Vercel 크론)과 같다: 휴지통 30일 파일 기록을 지우고, 그 객체·만료된 올리기 자리·1시간 넘게 등록 안 된 객체를 R2에서 지운 뒤 행을 정리,
// 하루 지난 OCR 한도 줄도 지운다. 환경 변수(값은 출력하지 않는다): VITE_SUPABASE_URL(또는 OFFICE_SUPABASE_URL) · OFFICE_SUPABASE_SERVICE_KEY · R2_ENDPOINT ·
// R2_OFFICE_BUCKET · R2_OFFICE_ACCESS_KEY_ID · R2_OFFICE_SECRET_ACCESS_KEY
import { sweepStorage } from '../server/sweep.js';
import { r2FromEnv } from '../server/r2.js';

const url = process.env.OFFICE_SUPABASE_URL || process.env.VITE_SUPABASE_URL, key = process.env.OFFICE_SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('VITE_SUPABASE_URL(또는 OFFICE_SUPABASE_URL)·OFFICE_SUPABASE_SERVICE_KEY 가 필요합니다(값은 출력하지 않음)'); process.exit(2); }
try {
  const out = await sweepStorage({ url, key, r2: r2FromEnv(process.env) });
  console.log(`정리: 객체 ${out.objects}개(못 지움 ${out.left}개) · 행 ${out.rows}개`);
} catch (e) { console.error('정리 실패:', e.code ?? e.message); process.exit(1); }
