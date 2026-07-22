"""
ocr_resident.py / ocr_credit_address.py / ocr_credit_score.py / ocr_subrogation_date.py가
공통으로 쓰는 PaddleOCR 초기화·페이지별 인식 헬퍼.

실 서버(Windows, CPU) 테스트로 확인된 이슈 대응:
- paddleocr 3.x 기본 파이프라인(PIR 실행기 + oneDNN 가속)에서 det/rec 모델을 돌릴 때
  "(Unimplemented) ConvertPirAttribute2RuntimeAttribute not support
  [pir::ArrayAttribute<pir::DoubleAttribute>]" 에러가 발생함을 확인 — PIR을 끄고(예전
  실행 경로 사용) enable_mkldnn=False로 가속도 꺼서 회피한다.
  (2026-07-22 재확인: FLAGS_enable_pir_api=0만으로는 이 에러가 안 막히고 enable_mkldnn=True로
  두면 여전히 동일 에러로 즉시 실패한다 — 두 플래그 다 꺼야 한다. enable_mkldnn=True로 바꾸지 말 것.)
- 문서방향분류/휘어짐보정/텍스트줄방향분류(use_doc_orientation_classify 등)는 스캔
  방향이 항상 바른 우리 문서에는 불필요해서 끈다 — 처리 속도도 빨라짐.
- PaddleOCR 엔진 생성(모델 로드)이 느려서, 한 프로세스 안에서는 한 번만 만들어 재사용한다.
"""
import os
os.environ.setdefault("FLAGS_enable_pir_api", "0")

import sys
import time
import fitz  # PyMuPDF
import tempfile

_ENGINE = None


def _dbg(msg):
    # 임시 디버그 — 어느 단계에서 시간이 오래 걸리는지 확인용 (원인 확인되면 제거할 것)
    print(f"[ocr_timing] {time.monotonic():.1f} {msg}", file=sys.stderr, flush=True)


def get_engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE

    _dbg("get_engine: start (import + model load)")
    from paddleocr import PaddleOCR
    common_kwargs = dict(
        lang="korean",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    try:
        _ENGINE = PaddleOCR(enable_mkldnn=False, **common_kwargs)
    except TypeError:
        _ENGINE = PaddleOCR(**common_kwargs)
    _dbg("get_engine: done")
    return _ENGINE


def ocr_pdf_pages(pdf_path, max_pages):
    """
    PDF 앞 max_pages 페이지를 OCR한다.
    반환: (pages_words, first_page_text)
      pages_words: [[(text, x, y), ...], ...] — 페이지별 인식된 텍스트 박스.
                   x, y는 박스 좌상단 좌표(정수).
      first_page_text: 1페이지에서 인식된 텍스트를 전부 이어붙인 문자열
                        (주민등록번호/발급일처럼 평문 정규식으로 찾는 값에 사용).
    """
    engine = get_engine()
    doc = fitz.open(pdf_path)
    tmp_files = []
    pages_words = []
    first_page_text = ""

    try:
        n_pages = min(max_pages, doc.page_count)
        _dbg(f"ocr_pdf_pages: doc.page_count={doc.page_count} n_pages={n_pages}")
        for page_num in range(n_pages):
            page = doc[page_num]
            mat = fitz.Matrix(3, 3)  # 3x 해상도
            pix = page.get_pixmap(matrix=mat)
            _dbg(f"page {page_num}: rendered {pix.width}x{pix.height}, predicting...")

            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                tmp_path = f.name
            tmp_files.append(tmp_path)
            pix.save(tmp_path)

            result = engine.predict(tmp_path)
            _dbg(f"page {page_num}: predict done, {len(result[0]['rec_texts']) if result else 0} boxes")
            page_words = []
            if result:
                res = result[0]
                texts = res["rec_texts"]
                boxes = res["rec_boxes"]
                for text, box in zip(texts, boxes):
                    t = (text or "").strip()
                    if not t:
                        continue
                    x1, y1 = int(box[0]), int(box[1])
                    page_words.append((t, x1, y1))
            pages_words.append(page_words)

            if page_num == 0:
                first_page_text = " ".join(t for t, _, _ in page_words)

        return pages_words, first_page_text
    finally:
        doc.close()
        for f in tmp_files:
            try:
                os.unlink(f)
            except Exception:
                pass
