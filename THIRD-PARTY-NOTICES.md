# 서드파티 고지 (Third-party notices)

## busybox-w32 (Windows 앱에만 동봉)

- 파일: 이 앱의 `resources/server/bin/busybox64u.exe` (UTF-8 매니페스트 빌드, 무수정 별도 실행 파일). 소스 저장소에서는 `vendor/busybox64u.exe`.
- 용도: 윈도우에서 크루의 Bash 도구가 쓰는 POSIX sh·코어 유틸(`src/engine/shell-backend.mjs`)
- 저작권: BusyBox — Copyright (C) 1998-2026 Erik Andersen, Rob Landley, Denys Vlasenko and others(상세 저작권 표기는 소스 배포본 참조); busybox-w32 이식 — Ron Yorston
- 라이선스: GNU General Public License v2 — 전문은 같은 폴더의 `busybox-w32-LICENSE`
- 출처: https://frippery.org/busybox/ · 소스 저장소: https://github.com/rmyorston/busybox-w32
- 동봉 판: BusyBox v1.38.0-FRP-6075-g169694ebd, 675,840B (sha256은 `scripts/fetch-busybox.mjs`에 고정)
- 대응 소스(GPLv2 §3): 같은 판의 소스 타르볼 `busybox-w32-FRP-6075-g169694ebd.tgz`(3,690,927B, sha256 고정)가 이 배포본이 올라간 릴리스 페이지에 자산으로 함께 있다. `node scripts/fetch-busybox.mjs source <dir>`로도 받는다.

Argo 자체 라이선스는 [LICENSE.md](LICENSE.md)를 본다.
