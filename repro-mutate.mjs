// 임시 변이 스크립트 — mkdir 게이트를 제거하고 옛 rename 단독 선점으로 되돌린다(결함 하나만).
// 강화된 선점 경합 테스트가 이 변이를 윈도우에서 red로 잡는지 확인하는 프로브(조사 후 삭제).
import { readFileSync, writeFileSync } from 'node:fs';

const f = 'src/crewmail.mjs';
const src = readFileSync(f, 'utf8');
const start = src.indexOf('    const gate = ');
const endMarker = '    await dropGate();\n';
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) { console.error('변이 앵커를 못 찾음'); process.exit(2); }
const mutated = src.slice(0, start)
  + "    const claimedPath = `${item.full}.claimed`;\n    try { await rename(item.full, claimedPath); } catch { continue; }\n"
  + src.slice(end + endMarker.length);
writeFileSync(f, mutated);
console.log('mutated: mkdir 게이트 제거 → rename 단독 선점(출하본과 동형)');
