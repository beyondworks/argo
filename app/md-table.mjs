/** 표의 각 칸에 머리글 이름을 data-label로 단다 — 좁은 화면(메신저 폰)이 한 행을 카드로 풀어 "머리글: 값"으로 보이게(유건 2026-09-17:
    열 4개가 390px에 욱여넣어져 '상대 요구' 칸이 한 글자씩 세로로 늘어났다). 넓은 화면은 속성만 붙고 모양은 그대로. 라벨은 태그를 벗긴 텍스트를 속성 이스케이프한다. */
export function labelTableCells(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (whole, inner) => {
    const head = inner.match(/<thead>([\s\S]*?)<\/thead>/);
    if (!head) return whole;
    const labels = [...head[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim().replace(/&(?![a-z#0-9]+;)/gi, '&amp;').replace(/"/g, '&quot;'));
    const body = inner.replace(/<tbody>([\s\S]*?)<\/tbody>/, (_, rows) => `<tbody>${rows.replace(/<tr>([\s\S]*?)<\/tr>/g, (__, cells) => { let i = 0; return `<tr>${cells.replace(/<td(\b[^>]*)>/g, (___, attrs) => { const l = labels[i++]; return l ? `<td${attrs} data-label="${l}">` : `<td${attrs}>`; })}</tr>`; })}</tbody>`);
    return `<table>${body}</table>`;
  });
}
