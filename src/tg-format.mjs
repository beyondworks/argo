// 텔레그램 발신 포맷 — 크루의 마크다운을 텔레그램 HTML로 변환한다.
// 원칙: 깨진 마크다운 원문(**, ##, |표|)을 사용자에게 노출하지 않는다.
// 실패 대비: 호출부는 HTML 발송 실패 시 plainText로 폴백한다.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 인라인 마크다운 → 텔레그램 HTML (이스케이프 후 태그 복원 순서 중요) */
function inline(md) {
  let s = esc(md);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/** 표 블록 → 등폭 정렬 텍스트 (텔레그램은 표가 없다 — pre로 살린다) */
function tableToPre(lines) {
  const rows = lines
    .filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)) // 구분선 제거
    .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  if (!rows.length) return '';
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, [...c].length); });
  const fmt = (r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return `<pre>${esc(rows.map(fmt).join('\n'))}</pre>`;
}

/**
 * 마크다운 전체 → 텔레그램 HTML.
 * 지원: 제목(굵게), 굵게/기울임/취소선/코드/링크, 인용(blockquote), 코드블록(pre),
 * 표(등폭 pre), 불릿/번호 목록, 수평선. [[위키링크]]는 제목만 남긴다.
 */
export function mdToTelegramHtml(md) {
  const src = String(md ?? '').replace(/\[\[([^\]]+)\]\]/g, '«$1»');
  const out = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // 코드블록
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (/^\s*\|.+\|/.test(line)) { // 표
      const buf = [];
      while (i < lines.length && /^\s*\|.+/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      out.push(tableToPre(buf));
      continue;
    }
    if (/^>\s?/.test(line)) { // 인용
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${buf.map(inline).join('\n')}</blockquote>`);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) { out.push(`<b>${inline(line.replace(/^#{1,6}\s+/, ''))}</b>`); i += 1; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      out.push(line.replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^(\s*\d+)\.\s+/, '$1. ').replace(/^(\s*(?:•|\d+\.)\s+)(.*)$/, (_, p, rest) => p + inline(rest)));
      i += 1; continue;
    }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) { out.push('———'); i += 1; continue; }
    out.push(inline(line));
    i += 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 4096 제한 대비 분할 — 잘라내지 않고 나눠 보낸다. 태그 경계 보호를 위해 줄 단위 분할. */
export function splitForTelegram(text, max = 3900) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = '';
  const push = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (let line of text.split('\n')) {
    while (line.length > max) { // 초장문 한 줄도 유실 없이 하드 분할
      push();
      chunks.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur.length + line.length + 1 > max) push();
    cur = cur ? `${cur}\n${line}` : line;
  }
  push();
  return chunks;
}

/** 응답 본문에서 발송할 파일 경로 추출 — vault 상대 경로만, 최대 3개. */
export function extractFileRefs(text) {
  const re = /(?:vault\/)?(files\/[\w\-.ㄱ-힝 ()]+\.(?:png|jpe?g|webp|gif|pdf|docx?|xlsx?|pptx?|csv|md|zip))/gi;
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(re)) seen.add(m[1]);
  return [...seen].slice(0, 3);
}

export const isImagePath = (p) => /\.(png|jpe?g|webp|gif)$/i.test(p);
