// 오피스 저장소 정리를 화면·Vercel 없이 직접 돌린다(분리 검수 MEDIUM 1) — 예: VPS cron `17 4 * * * node apps/office/scripts/files-sweep.mjs`.
// 하는 일은 api/files sweep(Vercel 크론)과 같다: 휴지통 30일 파일·하루 지난 행 없는 객체(office-files·office-docs)를 Storage API로 지우고 행을 정리,
// 지난 올리기 자리·OCR 한도 줄도 지운다. 환경 변수(값은 출력하지 않는다): VITE_SUPABASE_URL(또는 OFFICE_SUPABASE_URL) · OFFICE_SUPABASE_SERVICE_KEY
import { sweepStorage } from '../server/sweep.js';

const url = process.env.OFFICE_SUPABASE_URL || process.env.VITE_SUPABASE_URL, key = process.env.OFFICE_SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('VITE_SUPABASE_URL(또는 OFFICE_SUPABASE_URL)·OFFICE_SUPABASE_SERVICE_KEY 가 필요합니다(값은 출력하지 않음)'); process.exit(2); }
try {
  const out = await sweepStorage({ url, key });
  console.log(`정리: 객체 ${out.objects}개 · 행 ${out.rows}개`);
} catch (e) { console.error('정리 실패:', e.code ?? e.message); process.exit(1); }
