// 첨부 표시 규칙(2026-10-02) — 메신저 앱(말풍선)과 본체 게이트웨이(에이전트 파일 업로드 mime)가 같이 쓴다.
// 사람이 올린 파일은 브라우저가 준 mime을, 에이전트 파일은 게이트웨이가 정한 mime을, 봇 파일은 봇이 보낸 mime을 갖는다 —
// 셋이 달라도 같은 말풍선이 나오도록 "구체적인 mime이면 그대로, 비었거나 octet-stream이면 확장자"로 한 번에 정한다.
// 테스트: test/msgr-media-kind.test.mjs

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp', hwpx: 'application/haansofthwpx', key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown']);
// 말풍선 안에 그릴 수 있는 그림. heic·heif는 WebKit(iOS·macOS)만 그린다 — 못 그리면 화면이 파일 말풍선으로 물러난다.
const DRAWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/svg+xml']);

/** 마지막 점 뒤 확장자(소문자). 점으로 시작하는 이름(.env)·확장자 없음은 ''. */
export function fileExt(name) {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  return dot > 0 && dot < s.length - 1 ? s.slice(dot + 1).toLowerCase() : '';
}

/** 실제로 쓸 mime — 구체적인 값은 그대로(소문자·매개변수 제거), 비었거나 octet-stream이면 확장자로. */
export function mimeOf(name, mime) {
  const given = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (!GENERIC.has(given)) return given;
  return MIME[fileExt(name)] ?? 'application/octet-stream';
}

/** 말풍선 썸네일로 그릴 그림인가 — att: { name, mime } */
export function isImage(att) {
  if (!att) return false;
  return DRAWABLE.has(mimeOf(att.name, att.mime));
}

const KIND = [
  ['pdf', /^(pdf)$/], ['doc', /^(docx?|hwpx?|pages|rtf|odt)$/], ['sheet', /^(xlsx?|csv|tsv|numbers|ods)$/], ['slide', /^(pptx?|key|odp)$/],
  ['archive', /^(zip|gz|tgz|tar|7z|rar|bz2|xz)$/], ['video', /^(mp4|mov|webm|mkv|avi|m4v)$/], ['audio', /^(mp3|m4a|wav|ogg|flac|aac)$/],
  ['text', /^(txt|md|markdown|log)$/], ['code', /^(json|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|sh|sql|yaml|yml|toml|html|css|xml)$/],
  ['image', /^(png|jpe?g|gif|webp|heic|heif|avif|bmp|svg|tiff?)$/],
];
/** 파일 아이콘 갈래 — pdf | doc | sheet | slide | archive | video | audio | text | code | image | file */
export function fileKind(name, mime) {
  const ext = fileExt(name);
  for (const [k, re] of KIND) if (re.test(ext)) return k;
  const m = mimeOf(name, mime);
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/')) return 'text';
  return 'file';
}

/** 긴 파일 이름은 가운데를 줄인다 — 확장자(.docx)는 남겨 종류를 알게. 길이는 글자(코드 포인트) 단위. */
export function middleEllipsis(name, max = 28) {
  const chars = Array.from(String(name ?? ''));
  if (chars.length <= max) return chars.join('');
  const ext = fileExt(name);
  const keepExt = ext && ext.length + 1 <= Math.floor(max / 2);
  const tailFixed = keepExt ? Array.from(`.${ext}`) : [];
  const stem = keepExt ? chars.slice(0, chars.length - tailFixed.length) : chars;
  const room = max - tailFixed.length - 1; // 1 = '…'
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${stem.slice(0, head).join('')}…${tail > 0 ? stem.slice(-tail).join('') : ''}${tailFixed.join('')}`;
}

/** 사람이 읽는 크기 — 10 미만은 소수 한 자리(정수면 생략). */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  let v = Number(n);
  if (v < 1024) return `${Math.max(0, Math.round(v))} B`;
  for (const unit of ['KB', 'MB', 'GB']) {
    v /= 1024;
    if (v < 1024 || unit === 'GB') {
      const r = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
      return `${r} ${unit}`;
    }
  }
  return '';
}

/** 여러 장 묶음의 줄별 장수 — 한 줄 3장, 남는 1장은 마지막 두 줄을 2+2로(카톡 묶음과 같은 모양). */
export function gridRows(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (k <= 3) return k ? [k] : [];
  const rem = k % 3;
  const threes = rem === 1 ? (k - 4) / 3 : Math.floor(k / 3);
  return [...Array(threes).fill(3), ...(rem === 1 ? [2, 2] : rem === 2 ? [2] : [])];
}
