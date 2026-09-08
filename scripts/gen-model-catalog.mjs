// 릴리스 자산 model-catalog.json 생성 — 원격 카탈로그 오버레이(src/runners/catalog-remote.mjs)의 발행본.
// 사용: node scripts/gen-model-catalog.mjs [출력경로]   (기본 ./model-catalog.json)
// 기본은 빈 오버레이 = 코드 목록 그대로. 벤더가 모델을 바꾸면 이 파일만 고쳐 argo-agent 릴리스 자산으로 다시 올린다
// (앱 발행 불필요 — 20분 안에 전 기기 반영). 단 **그렇게 손으로 올린 핫픽스는 다음 발행이 이 스크립트 산출물로 덮어쓴다**
// (release.yml server 잡) — 그래서 폐기 모델의 retire/alias는 아래 LEGACY에 코드로 남긴다(분리 검수 H-1, 2026-09-08). 구버전 앱(카탈로그에
// 죽은 id가 남아 있는)도 같은 URL을 보므로 LEGACY가 그들의 크루 턴을 살린다.
// baseline은 사람 참고용(코드가 지금 아는 목록) — 로더는 읽지 않는다.
import { writeFile } from 'node:fs/promises';
import { RUNNERS } from '../src/runners/catalog.mjs';
import { SCHEMA, validateOverlay } from '../src/runners/catalog-remote.mjs';

const out = process.argv[2] || 'model-catalog.json';
/** 폐기 모델 → 대체 모델. 코드 카탈로그에서 뺀 id를 여기 옮긴다(옮기지 않으면 구버전 앱의 그 모델 크루가 유료 기본으로 강등되거나 404).
    2026-09-08: minimax-m3:free·m2.7:free 무료 종료, deepseek-v4-pro 서빙 종료. */
export const LEGACY = {
  openrouter: {
    // add = alias 목적지. 구버전 앱(코드 카탈로그에 대체 모델이 없는 ≤v0.1.64)에서는 add가 없으면 alias 목적지가 유효 목록 밖이라
    // chat.mjs가 기본 모델로 강등한다. 새 버전은 같은 id를 무시하므로 무해.
    add: [{ id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (Free)', free: true }], // free = 무료 배지·무료 폴백(2차 검수 MEDIUM-1)
    retire: ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free', 'deepseek/deepseek-v4-pro'],
    alias: { 'minimax/minimax-m3:free': 'nvidia/nemotron-3.5-lightning:free', 'minimax/minimax-m2.7:free': 'nvidia/nemotron-3.5-lightning:free' },
  },
};
const doc = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  runners: Object.fromEntries(Object.keys(RUNNERS).map((id) => [id, { add: [...(LEGACY[id]?.add ?? [])], retire: [...(LEGACY[id]?.retire ?? [])], alias: { ...(LEGACY[id]?.alias ?? {}) } }])),
  baseline: Object.fromEntries(Object.entries(RUNNERS).map(([id, r]) => [id, r.models.map((m) => m.id).filter(Boolean)])),
};
if (!validateOverlay(doc)) throw new Error('생성한 오버레이가 스키마 검증을 통과하지 못했다');
await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`model-catalog.json → ${out} (러너 ${Object.keys(doc.runners).length}개, legacy retire ${Object.values(LEGACY).reduce((n, l) => n + l.retire.length, 0)})`);
