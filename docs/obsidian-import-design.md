# 옵시디언 임포트 설계 — 외부 볼트를 Argo 스캐폴드로 증류

> 유건 확정 요구 2026-07-28. North Star: **사용자가 설정에서 옵시디언 볼트 폴더를 고르면,
> 산재된 노트가 Argo 구조(journal·notes·files)로 재분류되어 회사 기억이 되고, 못 가른 것은
> 미분류 폴더 + 리포트로 정직하게 안내된다.** 조용히 버리거나 아무 데나 밀어넣지 않는다.
> 제품 철학 기억(argo-product-philosophy): "옵시디언 임포트 = Argo 스캐폴드 재분류".

## 원칙 (불변)

1. **원본 볼트는 읽기 전용.** 임포트는 복사다 — 소스에 단 1바이트도 쓰지 않는다.
2. **기존 회사 데이터를 덮지 않는다.** 대상 파일명 충돌은 접미 번호(`-2`, `-3`)로 분리 저장
   (saveNote(create)와 같은 계열 — 기억 유실 금지).
3. **증류 불가는 버리지 않는다.** `vault/_imported/unsorted/`에 원본 상대경로 그대로 복사하고,
   건별 이유를 리포트에 싣는다.
4. **러너 없이 완결.** 규칙 기반만으로 임포트가 끝난다. LLM(크루) 증류는 Phase 2 훅 —
   미분류 폴더를 크루에게 "분류해줘"라고 시키면 되는 구조라, 별도 기능 없이도 이미 가능하다.
5. **서버 한국어 하드코딩 금지(K7 계열).** 오류·이유는 코드로 반환, UI가 i18n 매핑.
   단 리포트 md 파일은 회사 언어(company.json lang)를 따른다 — 크루 기억 노트와 같은 규약.

## 분류 규칙 (rel = 소스 볼트 기준 상대경로, 판정 순서대로)

| 순서 | 판정 | 목적지 | 근거 |
|---|---|---|---|
| 1 | 도트 항목(`.obsidian/`, `.trash/`, `.git/`, `.DS_Store`, 모든 도트 시작) | **건너뜀**(skip: `config`) | 앱 설정·휴지통은 기억이 아니다. 리포트에 개수만 |
| 2 | 템플릿 폴더(`templates/`, `_templates/`, `템플릿/` — 대소문자 무시) 안의 파일 | **미분류**(`template`) | 템플릿은 콘텐츠가 아니라 서식 — 크루 기억에 섞이면 오염 |
| 3 | 데일리 노트: 파일명 `YYYY-MM-DD*.md` (옵시디언 Daily Notes 기본) | **journal/** `YYYY-MM-DD-<원본이름잔여>-imported.md` | Argo 일지 kind 판정(vaultdoc.docKind)이 `^\d{4}-\d{2}-\d{2}-` 요구 — 이 이름이어야 인덱스 "최근 일지" 구간에 잡힌다 |
| 4 | 첨부 확장자(png·jpg·jpeg·gif·webp·svg·pdf·mp3·wav·m4a·mp4·mov·zip·pptx·docx·xlsx·csv·txt·json·html) | **files/imported/**<원본 상대경로 유지> | Argo files/ = 첨부 표준 위치. 폴더 구조 보존(맥락) |
| 5 | 그 외 `.md` | **notes/** (평탄화 — 폴더 경로는 버리고 파일명만. 충돌 시 `폴더명-파일명`, 그래도 충돌이면 접미 번호) | Argo notes/는 평면(listDocs 비재귀)이 정본 구조 |
| 6 | 빈 md(공백뿐) | **미분류**(`empty`) | 빈 노트가 주제 노트로 들어가면 인덱스 잡음 |
| 7 | 나머지(`.canvas`, `.base`, `.excalidraw`, 미지의 바이너리 등) | **미분류**(`unknown-type`) | Argo가 렌더할 수 없는 형식 — 크루가 읽을 수 없다 |
| 8 | 단일 파일 200MB 초과 | **복사 안 함**(skip: `too-large`, 건별 리포트) | 원본은 소스 볼트에 그대로 있다 — 리포트로 안내가 정직한 처리 |
| 9 | 심링크 | **건너뜀**(skip: `symlink`) | export.mjs와 같은 근거 — 볼트 밖을 가리키는 포인터가 워크스페이스로 실려 오는 것 차단 |

- 총량 상한: 파일 20,000개 / 합계 2GB 초과 시 시작 전에 거부(`too-many`, `too-big`) —
  워크스페이스는 클라우드 동기화 대상이라 무한정 실어 오면 안 된다(관문 0.5: 동기화 비용은
  파일 수·크기에 선형. 상한이 실증 부족하면 이후 올린다).

## 위키링크 처리

- 옵시디언 `[[이름]]`은 파일명 기준, Argo `[[rel]]`은 vault 상대경로 기준(ui.jsx Markdown →
  `이름.md`로 열기). 그대로 두면 임포트된 링크 전부가 404다.
- **notes/로 들어가는 md에 한해** 링크 타깃을 재작성한다:
  - 임포트한 md의 `원본 basename → 새 rel(notes/이름)` 맵을 만들고,
  - `[[타깃]]`, `[[폴더/타깃]]`, `[[타깃#섹션]]`, `[[타깃|별칭]]` → `[[notes/새이름]]`.
    (#섹션·|별칭은 Argo 렌더러가 지원하지 않아 남기면 링크가 죽는다 — 기능 보존이 표기 보존보다 우선)
  - 데일리 노트 타깃은 `[[journal/새이름]]`.
  - 맵에 없는 타깃(미임포트·외부)은 **원문 그대로 보존** — 임의 추측 재작성 금지.
  - basename 중복(다른 폴더의 같은 이름)은 먼저 배치된 쪽으로 맵핑하고 리포트에 `ambiguous-link` 경고.
- 첨부 임베드 `![[image.png]]`는 위 규칙과 동일하게 `![[files/imported/...]]`로 재작성.
  (Argo Markdown의 이미지 필터는 동일출처 `/` src만 허용 — 위키 임베드는 클릭 링크로 동작)

## 시간 보존

- 복사 후 `utimes`로 **원본 mtime 복원**. 안 하면 10년치 노트가 전부 "오늘 갱신"이 되어
  인덱스 최상단을 점령한다(주제 노트 정렬은 frontmatter `updated:` 1순위, mtime 2순위 —
  vaultdoc.noteDate). frontmatter가 이미 있으면 그대로 보존된다.

## 산출물

- 배치: 위 규칙대로 journal/·notes/·files/imported/·`vault/_imported/unsorted/`.
- 리포트: `vault/_imported/report-<ts>.md` (회사 언어) + API JSON 응답
  `{ journal, notes, files, unsorted: [{rel, reason}], skipped: [{rel, reason}], warnings, total }`
  (unsorted/skipped 목록은 각 200건 캡 — 리포트 md에는 전체).
- 완료 후 `updateIndex(ws)` 1회 — memindex 캐시는 readdir+stat 기반이라 신규 파일을 자동 흡수.

## 안전·경계

- 소스 경로 검증: `validateWorkRoot` 재사용(절대경로·존재·디렉토리·루트 전체 거부·보호 구역
  거부·realpath 봉인). WS_ROOT 안 경로가 거부되므로 **자기 워크스페이스 재귀 임포트가 원천 차단**된다.
- API: `POST /api/companies/[ws]/import/obsidian` — `guardCompany` + `csrfDenied`
  (export와 동일 근거: 로컬 모드에서 악성 웹페이지 simple POST가 임의 디스크 폴더를 회사로
  끌어와 클라우드 동기화로 유출시키는 경로 차단).
- 진행 표시: 임포트 중 `<ws>/.import-status.json`(직속 도트파일 — sync EXCLUDE·export 제외
  자동 적용)에 `{ phase, done, total }`을 기록, `GET .../import/obsidian`이 반환, UI가 실행 중에만
  1초 폴링(상시 타이머 아님 — 관문 0.5 해당 없음). 동시 실행은 mutex(withLock)로 직렬화.
- 파괴적 액션 아님: 덮어쓰기가 원천 없으므로 DangerModal 불요(규칙 확인함). 실행 전 **드라이런
  미리보기**(dryRun: 복사 없이 분류 계획 집계)를 같은 API로 제공 — "몇 건이 어디로 가는지" 보고
  사용자가 실행을 결정한다.

## UI (설정 → 데이터 섹션, ExportCard 옆)

- ImportCard: 경로 입력 + 데스크톱 네이티브 픽커(`@tauri-apps/plugin-dialog` —
  feat/trial-nudge-picker 도입분 기준, 웹은 텍스트 입력 폴백. ExportCard와 동일 패턴).
- 흐름: 폴더 선택 → [미리보기](dryRun) → 계획 표시(일지 n·노트 n·첨부 n·미분류 n) →
  [가져오기] → 진행률 → 결과(배치 요약 + 미분류 목록·이유 + 리포트 파일 위치).
- i18n ko/en 전 문자열(다국어 상시 규칙).

## Phase 2 (이번 범위 밖 — 훅만)

- 크루(LLM) 증류: `_imported/unsorted/`를 크루에게 맡기는 원클릭("크루에게 분류 맡기기") —
  러너 있는 사용자 전용. 이번엔 리포트에 그 경로를 안내하는 것까지만.
- 태그(frontmatter tags) → 노트 본문 유지 이상의 매핑(예: 태그별 폴더)은 실사용 신고 후.
