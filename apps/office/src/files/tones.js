// 문서함 줄·미리보기 뱃지의 값 — 유형 키와 태그 색. 목록(FilesPage)·미리보기(Preview)·시험(test/badge-tone.test.mjs)이 같은 규칙을 쓴다.
import { badgeTone } from '../ui/badge-tone.js';
import { CATEGORIES, kindOf } from './model.js';
import { FILES_DICT } from './files-i18n.js';

/** 유형 뱃지 키 — 링크·PDF·그림·문서·기타 */
export const kindKey = (f) => (f.kind === 'link' ? 'link' : kindOf(f.filename || f.title, f.mime));
/** 태그 색 — 분류 이름과 같은 태그(만든 견적서에 붙는 '견적서' 등)는 그 분류와 같은 색, 나머지는 글자마다 정해진 색 */
export const tagTone = (x) => badgeTone(CATEGORIES.find((c) => FILES_DICT[`files.cat.${c}`]?.includes(x)) ?? x);
