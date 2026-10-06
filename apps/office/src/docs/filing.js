// 서명본을 문서함에 넣고 '보관함' 표시하기(분리 검수 LOW 4) — 화면(DocsPage)과 테스트가 같은 규칙을 쓴다.
// 넣기에 실패하면(null) 표시하지 않는다 → 다음에 화면을 열 때 다시 한다. 다른 관리자가 이미 넣었으면({ conflict: true }) 서버가 같은 서명본을
// 두 번 받지 않으므로(office_files ref_id 유일) 표시만 한다. 한 건이 실패해도 다음 건은 이어서 한다.
export async function fileSignedCopies(todo, { pdf, entryOf, file, mark, warn = (...a) => console.warn(...a) }) {
  let filed = 0;
  for (const e of todo) {
    try {
      const bytes = await pdf(e);
      const r = await file(entryOf(e, bytes));
      if (!r) continue;
      await mark(e.id);
      filed++;
    } catch (err) { warn('[office docs] filing signed copy failed', err?.message); }
  }
  return filed;
}
