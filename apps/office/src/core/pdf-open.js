// pdf.js 문서 열고 닫기 — pdf.js 6부터 문서(PDFDocumentProxy)에는 destroy가 없고 불러오기 작업(loadingTask)에만 있다.
// 문서.destroy()를 부르면 'destroy is not a function'으로 글자 읽기 전체가 '실패'가 됐다(운영 결함 10/3). 작업 쪽으로 닫는다.
/** lib(pdf.js 모듈)로 data를 열어 fn(doc) 결과를 돌려주고, 성공·실패와 상관없이 작업을 닫는다 */
export async function withPdf(lib, data, fn, opts = {}) {
  const task = lib.getDocument({ data, ...opts });
  try { return await fn(await task.promise); } finally { await task.destroy(); }
}
