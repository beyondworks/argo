#!/usr/bin/env node
// P0 수직 슬라이스 데모 — PRODUCT-SPEC 검증 기준 5항목을 한 번에 실증한다.
//   ① 한 줄 → 페르소나 카드  ② 대화 응답  ③ 턴 핸드오버 vault 저장
//   ④ 유사 문서 자동 [[링크]]  ⑤ 다음 턴에서 vault 링크 따라 과거 맥락 인용
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCompany, paths } from './src/workspace.mjs';
import { createAgentFromPrompt } from './src/persona.mjs';
import { chat } from './src/chat.mjs';

const WS = 'demo-co';
await rm(join(paths(WS).root), { recursive: true, force: true });

console.log('== ① 회사 생성 ==');
const co = await createCompany(WS, '데모컴퍼니', 'yoogeon');
console.log('회사:', co.name, '→', paths(WS).root);

console.log('\n== ② 한 줄 프롬프트 → 에이전트 생성 ==');
const agent = await createAgentFromPrompt(WS, '전자상거래 D2C 브랜드의 퍼포먼스 광고 카피를 쓰는 마케터');
console.log('생성됨:', agent.name, `(${agent.slug})`, '—', agent.role);

console.log('\n== ③ 1턴: 지시 → 응답 + vault 핸드오버 ==');
const t1 = await chat(WS, agent.slug, '우리 브랜드는 무설탕 단백질 쿠키야. 타깃은 2030 헬스인. 메타 광고 헤드라인 3개만 뽑아줘.');
console.log('응답(앞 300자):', t1.reply.slice(0, 300));
console.log('핸드오버:', t1.handover.file);

console.log('\n== ④ 2턴(새 세션): 유사 주제 → 자동 링크 확인 ==');
// 새 세션(sessionId 미전달)으로 — 대화 히스토리가 아니라 vault만으로 맥락을 이어야 한다.
const t2 = await chat(WS, agent.slug, '지난번에 잡은 쿠키 브랜드 방향 기억나? 그 톤 그대로 인스타 스토리용 카피 2개 추가해줘.');
console.log('응답(앞 400자):', t2.reply.slice(0, 400));
console.log('자동 링크:', JSON.stringify(t2.handover.linked));

console.log('\n== 검증 요약 ==');
console.log('⑤ 과거 맥락 인용 여부는 위 2턴 응답에서 육안 확인(쿠키/타깃 언급 + 기록 파일명 언급).');
console.log('vault 트리와 _index.md를 확인하세요:', paths(WS).vault);
