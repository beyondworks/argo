// vault 문서 메타 추출 — 순수 함수만. memory.mjs(정본 읽기)와 memindex.mjs(캐시) 양쪽이 쓴다.
// 한쪽에만 두면 순환 import가 나고, 두 벌로 두면 캐시와 정본의 판정이 갈린다(= 캐시가 거짓말한다).
import { basename } from 'node:path';

/** 날짜(YYYY-MM-DD) — 사용자 로컬 기준. UTC로 자르면 오전에 쓴 글이 '어제'로 표기된다
    (saveHandover가 같은 이유로 로컬을 쓴다 — 이 코드베이스의 기존 규약). */
export function localDay(ms = Date.now()) {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 주제 노트의 유효 갱신일 — { date, exact }. frontmatter `updated:`가 1순위(exact), 없으면 파일 mtime(추정).
    크루에겐 노트 저장 도구가 없어 SDK 기본 Write로 직접 쓴다 → 그 노트엔 frontmatter가 없다. updated만으로
    정렬하면 크루가 손으로 남긴 지식이 통째로 바닥에 깔리므로 mtime을 2순위로 둔다.
    mtime은 근사치라 exact=false로 표시한다 — 인덱스가 근거 없는 확신을 주지 않게. */
export function noteDate(d) {
  const fm = d.text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]; // BOM 방어 + hub.mjs·persona.mjs와 같은 파서 형태
  const updated = fm?.match(/^\s*updated:\s*['"]?(\d{4}-\d{2}-\d{2})/m)?.[1];          // 따옴표·선행공백 허용
  if (updated) return { date: updated, exact: true };
  return { date: d.mtimeMs ? localDay(d.mtimeMs) : '', exact: false };
}

/** 인덱스 구간 분류. updateIndex가 쓰던 필터와 1:1로 대응한다 — 여기서 갈리면 캐시 산출물이 정본과 달라진다.
    conflict = sync가 텍스트 충돌 시 남기는 `<슬러그>.conflict-<기기>-<ts>.md`(sync.mjs). 내용은 옛 판인데
    mtime이 '지금'이라 주제 노트에 섞이면 최신인 척 최상단을 차지한다. */
export function docKind(rel) {
  const base = basename(rel);
  if (rel.startsWith('notes/')) return /\.conflict-.*\.md$/.test(rel) ? 'conflict' : 'note';
  if (rel.startsWith('journal/')) {
    if (/^\d{4}-\d{2}-\d{2}-/.test(base)) return 'journal';
    if (/^\d{4}-W\d{2}\.md$/.test(base)) return 'weekly';
    return 'other'; // 정리 산출물도 일지 원본도 아닌 것 — 인덱스에 싣지 않는다(기존 동작과 동일)
  }
  if (rel.startsWith('conversations/')) return 'legacy';
  if (rel.startsWith('org/')) return 'org'; // 팀 메신저 조직 문서 미러(G-2) — 읽기 전용, 주제 노트처럼 검색·인덱스에 오른다
  return 'other';
}

/** 문서 1개의 인덱스용 메타. 본문(text)은 여기서 버린다 — 인덱스 렌더링에 더는 필요 없다.
    이 함수가 정본 경로와 캐시 경로의 유일한 판정 지점이다. */
export function docMeta(rel, text, mtimeMs) {
  return {
    rel,
    kind: docKind(rel),
    title: text.match(/^#\s*(.+)$/m)?.[1] ?? basename(rel, '.md'),
    links: [...text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]),
    stamp: noteDate({ text, mtimeMs }),
    mtimeMs,
  };
}
