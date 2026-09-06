// 릴리스 자산 model-catalog.json 생성 — 원격 카탈로그 오버레이(src/runners/catalog-remote.mjs)의 발행본.
// 사용: node scripts/gen-model-catalog.mjs [출력경로]   (기본 ./model-catalog.json)
// 첫 발행은 **빈 오버레이**(add/retire/alias 전부 비움) = 코드 목록 그대로. 벤더가 모델을 바꾸면 이 파일만
// 고쳐 argo-agent 릴리스 자산으로 다시 올린다(앱 발행 불필요 — 20분 안에 전 기기 반영).
// baseline은 사람 참고용(코드가 지금 아는 목록) — 로더는 읽지 않는다.
import { writeFile } from 'node:fs/promises';
import { RUNNERS } from '../src/runners/catalog.mjs';
import { SCHEMA, validateOverlay } from '../src/runners/catalog-remote.mjs';

const out = process.argv[2] || 'model-catalog.json';
const doc = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  runners: Object.fromEntries(Object.keys(RUNNERS).map((id) => [id, { add: [], retire: [], alias: {} }])),
  baseline: Object.fromEntries(Object.entries(RUNNERS).map(([id, r]) => [id, r.models.map((m) => m.id).filter(Boolean)])),
};
if (!validateOverlay(doc)) throw new Error('생성한 오버레이가 스키마 검증을 통과하지 못했다');
await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`model-catalog.json → ${out} (러너 ${Object.keys(doc.runners).length}개, 빈 오버레이)`);
