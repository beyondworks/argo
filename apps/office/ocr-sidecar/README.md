# 오피스 OCR 사이드카 (PaddleOCR)

유건 결정(10/2): 서버 OCR은 이 사이드카만 쓴다. 문서를 구글 등 외부 OCR로 보내지 않는다. 설정이 없으면 오피스는 브라우저 OCR로 읽고, 올리기는 실패하지 않는다.

- 엔진: PaddleOCR 한국어 모델 — 인트라넷 `scripts/ocr_server.py`와 같은 엔진·같은 줄 정리. 인트라넷 판은 파일 경로를 받지만, 오피스는 서버리스라 원본 바이트를 받는다(`POST /ocr-bytes`).
- PDF는 모든 쪽을 읽는다(기본 상한 300쪽 — 넘으면 앞 300쪽과 `truncated: true`).
- 받은 문서는 디스크에 쓰지 않는다(메모리에서만, 응답 뒤 버림). 문서 내용·파일 이름은 로그에 남기지 않는다.
- 키 필수(`Authorization: Bearer`, 16자 이상, 상수 시간 비교). 요청 크기 상한 20MB(오피스 `OCR_MAX`와 같다).

## 배포 (VPS, 유건 승인 뒤)

1. `/opt/argo-office-ocr/`에 `ocr_server.py`·`requirements.txt`를 두고 `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.
   첫 요청 때 모델(수십 MB)을 `.paddlex`에 받는다.
2. `/etc/argo-office-ocr.env`(권한 600)에 `OCR_KEY`·`OCR_HOST=127.0.0.1`·`OCR_PORT=8765`를 적는다. 값은 문서·채팅에 적지 않는다.
3. `argo-office-ocr.service`를 `/etc/systemd/system/`에 두고 `systemctl enable --now argo-office-ocr`.
4. 바깥에는 HTTPS 역방향 프록시(Caddy·nginx — 예: `ocr.<도메인>` → `127.0.0.1:8765`)로만 연다. 사이드카는 루프백에만 묶인다.
5. 오피스(Vercel) 환경 변수: `OFFICE_OCR_URL`(https 주소 — 평문 http는 같은 기계의 루프백만 받는다)·`OFFICE_OCR_KEY`(2의 키와 같은 값).
6. 확인: `curl -s https://ocr.<도메인>/health` → `{"ok":true}`, 키 없이 `/ocr-bytes` → 401.

오피스 쪽 규칙: `apps/office/server/ocr.js`(주소·키 검사), 요청 전 로그인 확인과 사람마다 시간당 60회 한도는 `apps/office/api/files/[op].js`.
