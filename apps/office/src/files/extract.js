// 문서 파일 글자 꺼내기(브라우저, 라이브러리 없음) — 인트라넷은 문서(docx·xlsx 등)를 '미지원'으로 두었다. 오피스는 본문 검색까지 된다.
// · 글(txt·csv·md·json): UTF-8로 읽고, 깨지면 EUC-KR(한글 윈도우 csv)로 다시 읽는다.
// · zip 문서(docx·xlsx·pptx·hwpx·odt·ods·odp): 압축 목록을 직접 읽어 본문 xml만 풀고(DecompressionStream deflate-raw) 태그를 걷는다.
// · hwp(옛 한글 바이너리)·그 밖의 형식: 'unsupported'.
// 규칙은 test/files-extract.test.mjs(실제 zip을 만들어 확인).

const TEXT = /\.(txt|csv|tsv|md|markdown|json|log|xml|ya?ml)$/i;
const ZIP_PARTS = [
  [/\.docx$/i, (n) => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n)],
  [/\.xlsx$/i, (n) => n === 'xl/sharedStrings.xml'],
  [/\.pptx$/i, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)],
  [/\.hwpx$/i, (n) => /^Contents\/section\d+\.xml$/.test(n)],
  [/\.(odt|ods|odp)$/i, (n) => n === 'content.xml'],
];

export function decodeText(bytes) {
  const utf = new TextDecoder('utf-8').decode(bytes);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('euc-kr').decode(bytes); } catch { return utf; }
}

/** xml → 글. 문단·줄·칸 끝은 줄바꿈, 탭은 탭, 엔티티 풀기 */
export function xmlText(xml) {
  return String(xml)
    .replace(/<(w:tab|hp:tab|text:tab)\b[^>]*\/>/g, '\t')
    .replace(/<\/(w:p|a:p|hp:p|text:p|text:h|si|row|table:table-row)>/g, '\n')
    .replace(/<(w:br|a:br|text:line-break)\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase()] ?? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)))
    .replace(/[ \t]*\n[ \t]*\n+/g, '\n')
    .trim();
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zip 목록에서 want(이름)에 맞는 항목을 풀어 [{ name, bytes }] — 중앙 목록(central directory) 기준 */
export async function unzipParts(buf, want) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [], dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true),
      xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(name) || dv.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method === 0) out.push({ name, bytes: data });
    else if (method === 8) out.push({ name, bytes: await inflate(data) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** 파일 → { status: 'done'|'unsupported'|'failed', text } */
export async function extractDocText(blob, name = '') {
  try {
    if (TEXT.test(name) || /^text\//.test(blob?.type ?? '')) return { status: 'done', text: decodeText(new Uint8Array(await blob.arrayBuffer())) };
    const part = ZIP_PARTS.find(([re]) => re.test(name));
    if (!part) return { status: 'unsupported', text: '' };
    const parts = await unzipParts(await blob.arrayBuffer(), part[1]);
    if (!parts.length) return { status: 'failed', text: '' };
    return { status: 'done', text: parts.map((x) => xmlText(new TextDecoder().decode(x.bytes))).join('\n\n').trim() };
  } catch { return { status: 'failed', text: '' }; }
}
