"""아르고 오피스 OCR 사이드카 — PaddleOCR(한국어), 인트라넷 scripts/ocr_server.py와 같은 엔진·같은 줄 정리.

유건 결정(10/2): 문서는 구글 등 외부 OCR로 보내지 않는다. 오피스 서버 함수(api/files ocr)가 이 사이드카만 부른다.
인트라넷 판과 다른 점: 파일 경로 대신 원본 바이트를 받는다(오피스는 서버리스라 공유 디스크가 없다).

  POST /ocr-bytes   Authorization: Bearer <OCR_KEY>   본문 = PDF·그림 원본 바이트(application/octet-stream)
                    x-file-kind: pdf|image(없으면 바이트 머리로 판정)   → { "text": "..." }
  GET  /health      → { "ok": true }  (인증 없음 — 내용 없음)

- 키 필수: OCR_KEY(16자 이상)가 없으면 시작하지 않는다. 비교는 상수 시간.
- 크기 상한: OCR_MAX_BYTES(기본 20MB — 오피스 OCR_MAX와 같다). 넘으면 읽지 않고 413.
- PDF는 모든 쪽을 읽는다(OCR_MAX_PAGES, 기본 300쪽 — 그 이상은 앞 300쪽만, 응답 truncated: true).
- 받은 문서는 디스크에 남기지 않는다: 바이트는 메모리에서만 다루고(임시 파일 없음) 응답 뒤 버린다. 문서 내용·파일 이름은 로그에 남기지 않는다.
- 모델은 한 번에 한 요청만 쓴다(PaddleOCR 예측기는 동시 사용에 안전하지 않다).

실행: OCR_KEY=... python ocr_server.py  (기본 127.0.0.1:8765 — 바깥에는 HTTPS 역방향 프록시로만 연다. README.md)
"""
import hmac
import io
import os
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

OCR_KEY = os.environ.get("OCR_KEY", "")
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(20 * 1024 * 1024)))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "300"))
SCALE = float(os.environ.get("OCR_SCALE", "2.0"))

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_ocr = None
_lock = threading.Lock()


def get_ocr():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR
        _ocr = PaddleOCR(
            lang="korean",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _ocr


def _as_dict(res):
    """predict 결과 1건에서 dict 추출(구조 변동 대비 방어적 — 인트라넷 판과 같다)."""
    if isinstance(res, dict):
        return res
    if hasattr(res, "json") and isinstance(getattr(res, "json"), dict):
        return res.json
    if hasattr(res, "__getitem__"):
        try:
            return dict(res)
        except Exception:
            return None
    return None


def _box_xyxy(b):
    try:
        if len(b) == 4 and not hasattr(b[0], "__len__"):
            return float(b[0]), float(b[1]), float(b[2]), float(b[3])
        xs = [float(p[0]) for p in b]
        ys = [float(p[1]) for p in b]
        return min(xs), min(ys), max(xs), max(ys)
    except Exception:
        return None


def _layout_from_dict(d) -> str:
    """rec_texts + 박스 좌표로 읽기 순서 복원 — 같은 행은 한 줄로, 큰 수직 간격은 빈 줄(인트라넷 판과 같은 규칙)."""
    if "res" in d and isinstance(d["res"], dict):
        d = d["res"]
    texts = d.get("rec_texts") or []
    boxes = d.get("rec_boxes")
    polys = d.get("rec_polys")
    if polys is None:
        polys = d.get("dt_polys")
    items = []
    for i, t in enumerate(texts):
        if not t:
            continue
        box = None
        if boxes is not None and i < len(boxes):
            box = _box_xyxy(boxes[i])
        if box is None and polys is not None and i < len(polys):
            box = _box_xyxy(polys[i])
        items.append((t, box))
    coded = [(t, b) for t, b in items if b]
    if not coded:
        return "\n".join(t for t, _ in items)
    coded.sort(key=lambda it: ((it[1][1] + it[1][3]) / 2, it[1][0]))
    heights = [b[3] - b[1] for _, b in coded]
    avg_h = (sum(heights) / len(heights)) if heights else 12.0
    thr = avg_h * 0.6
    rows, cur, cur_y = [], [], None
    for t, b in coded:
        cy = (b[1] + b[3]) / 2
        if cur_y is None or abs(cy - cur_y) <= thr:
            cur.append((t, b))
            cur_y = cy if cur_y is None else (cur_y + cy) / 2
        else:
            rows.append(cur)
            cur, cur_y = [(t, b)], cy
    if cur:
        rows.append(cur)
    out, prev_bottom = [], None
    for row in rows:
        row.sort(key=lambda it: it[1][0])
        line = " ".join(t.strip() for t, _ in row).strip()
        if not line:
            continue
        top = min(b[1] for _, b in row)
        if prev_bottom is not None and (top - prev_bottom) > avg_h * 0.8:
            out.append("")
        out.append(line)
        prev_bottom = max(b[3] for _, b in row)
    return "\n".join(out)


def _ocr_array(arr) -> str:
    res = get_ocr().predict(input=arr)
    parts = []
    for r in res or []:
        d = _as_dict(r)
        if isinstance(d, dict) and ("rec_texts" in d or "res" in d):
            parts.append(_layout_from_dict(d))
    return "\n".join(p for p in parts if p)


def extract_image(data: bytes) -> str:
    import numpy as np
    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:  # 너무 큰 그림은 PIL이 DecompressionBombError로 거절한다
        rgb = im.convert("RGB")
    return _ocr_array(np.array(rgb)[:, :, ::-1])  # PaddleOCR는 BGR 배열


def extract_pdf(data: bytes):
    import numpy as np
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)  # 메모리에서 연다(임시 파일 없음)
    try:
        total = len(pdf)
        parts = []
        for i in range(min(total, MAX_PAGES)):
            page = pdf[i]
            try:
                pil = page.render(scale=SCALE).to_pil().convert("RGB")
            finally:
                page.close()
            parts.append(_ocr_array(np.array(pil)[:, :, ::-1]))
        return "\n\n".join(p for p in parts if p), total > MAX_PAGES
    finally:
        pdf.close()


def _work(kind: str, data: bytes):
    with _lock:
        if kind == "pdf":
            text, truncated = extract_pdf(data)
            return {"text": text, **({"truncated": True} if truncated else {})}
        return {"text": extract_image(data)}


def _authorized(request: Request) -> bool:
    got = request.headers.get("authorization", "")
    want = f"Bearer {OCR_KEY}"
    return bool(OCR_KEY) and hmac.compare_digest(got.encode(), want.encode())


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr-bytes")
async def ocr_bytes(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BYTES):
        return JSONResponse({"error": "too_big"}, status_code=413)
    buf = bytearray()
    async for chunk in request.stream():  # 길이를 속여도 상한에서 끊는다
        buf += chunk
        if len(buf) > MAX_BYTES:
            return JSONResponse({"error": "too_big"}, status_code=413)
    data = bytes(buf)
    del buf
    if not data:
        return JSONResponse({"error": "empty"}, status_code=400)
    kind = request.headers.get("x-file-kind") or ("pdf" if data[:5] == b"%PDF-" else "image")
    try:
        return await run_in_threadpool(_work, kind, data)  # 모델은 스레드에서 — /health가 막히지 않게
    except Exception as e:  # noqa: BLE001 — 문서 내용은 싣지 않고 종류만
        return JSONResponse({"error": "ocr", "kind": type(e).__name__}, status_code=422)
    finally:
        del data


if __name__ == "__main__":
    if len(OCR_KEY) < 16:
        raise SystemExit("OCR_KEY(16자 이상)가 필요합니다 — 값은 출력하지 않습니다")
    import uvicorn

    uvicorn.run(app, host=os.environ.get("OCR_HOST", "127.0.0.1"), port=int(os.environ.get("OCR_PORT", "8765")), log_level="warning", access_log=False)
