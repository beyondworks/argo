// 기억 편집 저장 결과 판정 — JSX 없는 순수 함수(F6). 409 vault_conflict만 "새로 불러오기/내 것으로 덮기" 선택지를 보인다.
export function vaultSaveOutcome(status, body) {
  if (status >= 200 && status < 300) return 'saved';
  if (status === 409 && body?.errorCode === 'vault_conflict') return 'conflict';
  return 'error';
}

/** 읽기 화면에서만 frontmatter(`---` 머리)를 뗀다 — marked가 'title: …' 다음 '---'을 제목 밑줄로 읽어 내부 메타데이터가 굵은 제목으로
    보였다(UX-A11). 편집 모드는 원문 그대로. 정규식은 내보내기(src/office-export.mjs parseBlocks)와 같다. */
export function stripFrontmatter(md) {
  return String(md ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
