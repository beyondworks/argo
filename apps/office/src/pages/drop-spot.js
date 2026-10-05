// 페이지에 끌어 놓은 파일을 넣을 자리(순수 — 편집기 모양만 안다). 화면은 PageView.jsx, 규칙 시험은 test/drop-spot.test.mjs.

/** pos가 든 맨 바깥 블록의 끝 자리 — 파일 블록을 문단·목록 사이에만 넣는다 */
export const blockAfter = (doc, pos) => { const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size))); return $p.depth >= 1 ? $p.after(1) : $p.pos; };

/** 놓은 자리 따라가기(분리 검수 LOW-8) — 올리는 동안 문서가 바뀌면(내가 치거나 다른 기기가 고치면) 그 변경만큼 자리를 옮긴다(ProseMirror mapping).
 *  place(편집기): 지금 문서 기준 넣을 자리 — 놓은 자리가 없거나 범위 밖이거나 편집기가 새로 열렸으면(다른 문서) 문서 끝.
 *  moved(pos): 하나 넣은 뒤 다음 파일은 그 뒤에. stop(): 따라가기를 끝낸다(올리기가 끝나면 꼭 부른다) */
export function dropSpot(editor, pos) {
  let host = editor && !editor.isDestroyed ? editor : null, at = host ? pos : null;
  const follow = ({ transaction }) => { if (at != null && transaction.docChanged) at = transaction.mapping.map(at); };
  host?.on('transaction', follow);
  return {
    place(live) {
      if (live !== host) { host?.off('transaction', follow); host = live; at = null; live.on('transaction', follow); }
      const doc = live.state.doc;
      return at == null || at > doc.content.size ? doc.content.size : blockAfter(doc, at);
    },
    moved(next) { at = next; },
    stop() { host?.off('transaction', follow); host = null; },
  };
}
