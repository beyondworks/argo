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
    // 2026-11-16: nemotron-3-super-120b-a12b:free 무료판이 공개 목록에서 사라졌다(유료판만 남음).
    retire: ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free', 'deepseek/deepseek-v4-pro', 'nvidia/nemotron-3-super-120b-a12b:free'],
    alias: {
      'minimax/minimax-m3:free': 'nvidia/nemotron-3.5-lightning:free', 'minimax/minimax-m2.7:free': 'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-super-120b-a12b:free': 'nvidia/nemotron-3.5-lightning:free',
    },
  },
  // Antigravity(2026-11-27, antigravity.google/docs/models + `agy models` 실측):
  //  · 2026-11-16 종료분(Claude Sonnet 4.6·Opus 4.6 Thinking·GPT-OSS 120B)의 목적지였던 3.6 Flash가 이제 Enterprise 전용이라 Hydrogen으로 다시 잡는다.
  //  · Gemini 3.7·3.6 Flash·3.1 Pro가 Enterprise 전용이 됐다(개인 구독 계정 목록에 없음) → 같은 사고 수준의 Gemini 4 Hydrogen으로 옮긴다.
  //  옛 앱 목록에는 Gemini 4가 없으므로 add로 넣는다. 옛 id를 모두 retire하면 옛 앱 목록은 add만 남고, 첫 add(Hydrogen Medium)가 러너 전환 기본값이 된다
  //  (applyOverlay: retire로 거른 뒤 add를 뒤에 붙임). 새 앱은 코드 목록에서 뺀 것만으로도 목록 밖 → 첫 항목(Hydrogen Medium)으로 돈다.
  //  대체 강도 표(RETIRED_MODEL_ALIASES)는 쓰지 않는다 — Antigravity는 사고 수준을 id에 담는다.
  //  원격 오버레이를 읽는 판(v0.1.81, #432)부터 적용되고, 그 전 판(v0.1.80 이하)은 앱 업데이트로만 풀린다.
  antigravity: {
    add: [
      { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen' },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen Low' },
      { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen High' },
    ],
    retire: [
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
      'gemini-3.7-flash-medium', 'gemini-3.7-flash-high', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-medium', 'gemini-3.6-flash-high', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    ],
    alias: {
      'claude-sonnet-4-6': 'gemini-4-hydrogen-medium', 'claude-opus-4-6-thinking': 'gemini-4-hydrogen-high', 'gpt-oss-120b-medium': 'gemini-4-hydrogen-medium',
      'gemini-3.7-flash-medium': 'gemini-4-hydrogen-medium', 'gemini-3.7-flash-high': 'gemini-4-hydrogen-high', 'gemini-3.7-flash-low': 'gemini-4-hydrogen-low',
      'gemini-3.6-flash-medium': 'gemini-4-hydrogen-medium', 'gemini-3.6-flash-high': 'gemini-4-hydrogen-high', 'gemini-3.6-flash-low': 'gemini-4-hydrogen-low',
      'gemini-3.1-pro-high': 'gemini-4-hydrogen-high', 'gemini-3.1-pro-low': 'gemini-4-hydrogen-low',
    },
  },
  // 2026-10-09: GPT-5.5 종료(Codex 서버 목록 retirement_at 2026-10-14T19:00Z). 목적지 5.6 Sol은 모든 옛 앱의 코드 목록에 있어 add가 필요 없다.
  // 6.1 Sol로 보내지 않는다 — 핀 0.157.1 옛 앱에서 400. 새 앱은 catalog.mjs RETIRED_MODEL_ALIASES로 같은 목적지(test/model-catalog-legacy.test.mjs가 대조).
  codex: {
    retire: ['gpt-5.5'],
    alias: { 'gpt-5.5': 'gpt-5.6-sol' },
  },
  // 2026-10-14: Gemini 2.5 Pro·Flash가 새 계정에 404(예전 사용 계정만 — catalog.mjs gemini 주석). 옛 앱(≤0.1.107)은 코드 목록에 3.8 Flash가 없어 add로 넣고,
  // 고른 2.5 id를 3.8 Flash로 옮긴다. retire는 하지 않는다 — 옛 앱 목록에서 2.5를 빼면 첫 항목(러너 전환 때 고르는 모델)이 무료 등급 없는 3.1 Pro Preview(gated)가 되고,
  // 남겨 두면 2.5를 골라도 alias가 3.8로 돌린다. 연결 확인·모델 없는 카드는 옛 앱 코드 상수(2.5 Pro)라 원격으로 못 고친다 — 앱 업데이트(0.1.108)로.
  gemini: {
    add: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
    retire: [], // 빈 배열로 둔다 — 아래 생성 로그가 LEGACY 항목마다 retire.length를 읽는다(없으면 발행 잡이 exit 1)
    alias: { 'gemini-2.5-pro': 'gemini-3.8-flash', 'gemini-2.5-flash': 'gemini-3.8-flash' },
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
