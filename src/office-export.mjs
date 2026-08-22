// 기억(markdown) → docx / xlsx / csv 내보내기. 외부 의존 없이 — docx·xlsx는 "ZIP 안의 XML"이라
// 최소 ZIP 기록기(stored, CRC32)와 최소 OOXML만으로 충분하다(유건 지시 2026-08-21 4-2, md·pdf는 선행).
// ponytail: 서식은 제목·문단·불릿·표까지. 이미지·각주·병합셀은 안 다룬다 — 필요해지면 docx 라이브러리로.
import { deflateRawSync } from 'node:zlib';

/* ─── ZIP ─── */
const CRC_T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
export function zip(files) { // [{name, data:string|Buffer}] → Buffer (deflate)
  const parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const data = deflateRawSync(raw), crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, data); central.push(c, name); off += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

/* ─── markdown 블록 파서(최소) ─── */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\((.+?)\)/g, '$1').trim();
const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c));
export function parseBlocks(md) {
  const text = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); // frontmatter 제거
  const lines = text.split(/\r?\n/); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const rows = [splitRow(l)]; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      i--; out.push({ type: 'table', rows }); continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)/); if (h) { out.push({ type: 'h', level: h[1].length, text: inline(h[2]) }); continue; }
    const b = l.match(/^\s*[-*]\s+(.*)/); if (b) { out.push({ type: 'li', text: inline(b[1]) }); continue; }
    if (l.trim()) out.push({ type: 'p', text: inline(l) });
  }
  return out;
}

/* ─── CSV — 표만(여러 표는 빈 줄로 구분). 표가 없으면 문단을 한 열로 ─── */
export function toCsv(md) {
  const blocks = parseBlocks(md);
  const cell = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const tables = blocks.filter((b) => b.type === 'table');
  const rows = tables.length ? tables.flatMap((t, i) => [...(i ? [[]] : []), ...t.rows]) : blocks.map((b) => [b.text]);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'; // BOM — 엑셀 한글 깨짐 방지
}

/* ─── XLSX — 표마다 시트 하나(없으면 본문 시트). 인라인 문자열, 서식 없음 ─── */
export function toXlsx(md, title = 'memory') {
  const blocks = parseBlocks(md);
  const tables = blocks.filter((b) => b.type === 'table');
  const sheets = tables.length ? tables.map((t, i) => ({ name: `표${i + 1}`, rows: t.rows })) : [{ name: '본문', rows: blocks.map((b) => [b.text]) }];
  const col = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => /^-?\d+(\.\d+)?$/.test(v) ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')
  }</sheetData></worksheet>`;
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  void title;
  return zip(files);
}

/* ─── DOCX — 제목(Heading1~3)·문단·불릿·표 ─── */
export function toDocx(md) {
  const blocks = parseBlocks(md);
  const run = (t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(t)}</w:p>`;
  const body = blocks.map((b) => {
    if (b.type === 'h') return para(b.text, `Heading${Math.min(b.level, 3)}`);
    if (b.type === 'li') return `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${run('• ' + b.text)}</w:p>`;
    if (b.type === 'table') return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr>${
      b.rows.map((r, ri) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r>${ri === 0 ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl><w:p/>`;
    return para(b.text);
  }).join('');
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${
      [['Heading1', 36], ['Heading2', 30], ['Heading3', 26]].map(([id, sz]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id.replace('Heading', 'heading ')}"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`).join('')
    }<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>` },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>` },
  ];
  return zip(files);
}

export const EXPORTS = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', make: toDocx },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', make: toXlsx },
  csv: { mime: 'text/csv; charset=utf-8', make: toCsv },
};
