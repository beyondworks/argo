// 그래파이트 테마 동기화 — 계약 본문은 test/helpers/theme-family.mjs(리넨과 공유). 앵커는 이 가족의 .side 규칙.
import { themeFamilyTests } from './helpers/theme-family.mjs';

themeFamilyTests('graphite', {
  sideLight: ":root[data-theme='graphite'] .side { background: #f0f0f0; }",
  sideDark: ":root[data-theme='graphite'] .side { background: #1d1d1d; }",
});
