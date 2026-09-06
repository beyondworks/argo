# 서드파티 고지 (Third-party notices)

## busybox-w32 (Windows 앱에만 동봉)

- 파일: `vendor/busybox64u.exe`(레포 동봉본) → 윈도우 앱 `resources/server/bin/busybox64u.exe` (UTF-8 매니페스트 빌드, 무수정 별도 실행 파일)
- 용도: 윈도우에서 크루의 Bash 도구가 쓰는 POSIX sh·코어 유틸(`src/engine/shell-backend.mjs`)
- 저작권: BusyBox — Copyright (C) 1998-2015 Erik Andersen, Rob Landley, Denys Vlasenko and others; busybox-w32 port — Ron Yorston
- 라이선스: GNU General Public License v2 (https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)
- 출처: https://frippery.org/busybox/ · 소스: https://github.com/rmyorston/busybox-w32
- 동봉 판: BusyBox v1.38.0-FRP-6075-g169694ebd, 675,840B (sha256은 `scripts/fetch-busybox.mjs`에 고정)
- GPLv2 의무: 이 실행 파일에 해당하는 소스 코드는 위 저장소의 같은 태그에서 받을 수 있다. 배포본과 함께 소스 스냅샷을 제공해야 하는지는 배포 형태에 따라 검토한다(발행 시 소스 타르볼을 릴리스 자산에 함께 올리는 것을 권장).

Argo 자체 라이선스는 [LICENSE.md](LICENSE.md)를 본다.
