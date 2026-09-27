// 오피스 메일 번역 속도 측정(개발용) — 이 맥의 구독 로그인으로 실제 모델을 불러, 첫 묶음·전체 시간을 잰다.
// 실행: ARGO_ROOT=<임시 폴더> node scripts/office-translate-bench.mjs [묶음 수 상한]
import { handleTranslate } from '../src/gateway/office-translate.mjs';
const para = [
  'Hi team, thanks for the quick turnaround on the revised quote for Hanbit Corporation.',
  'Before we send it out, could you double-check the unit price for the 1,800-unit tier and confirm the delivery schedule for October?',
  'Our procurement lead mentioned that the previous invoice listed the wrong billing address, so please update it to the Seoul office.',
  'We would also like to schedule a short call next Tuesday to walk through the onboarding plan for the new warehouse staff.',
  'Let me know which time works best for you, and feel free to loop in anyone from operations who should join.',
];
const items = Array.from({ length: 40 }, (_, i) => `${para[i % para.length]} (${i + 1})`);
const per = +(process.env.PER ?? 6); const bs = []; for (let i = 0; i < items.length; i += per) bs.push({ i: bs.length, items: items.slice(i, i + per) });
const t0 = Date.now(); const marks = [];
await handleTranslate('tr-bench', { rid: `bench-${t0}`, lang: 'ko', batches: bs.slice(0, +(process.argv[2] ?? bs.length)) }, {
  send: async (event, p) => { marks.push({ event, i: p.i, ms: Date.now() - t0, n: p.items?.length, partial: p.partial, code: p.code, message: p.message }); },
});
console.log(JSON.stringify({ chars: items.join('').length, batches: bs.length, marks }, null, 1));
