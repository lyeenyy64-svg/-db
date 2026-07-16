"""
CB종합보고서 PDF에서 최신 주소지·연락처(휴대폰)·조회일자 추출 (Windows OCR)
사용법: python ocr_credit_address.py <pdf_path>
출력: JSON {
  "ok": true, "address": "서울특별시 ...", "phone": "010-0000-0000",
  "queriedDate": "2026-07-10", "debugRows": [...]
} 또는 {"ok": false, "error": "..."}

보통 3페이지 근처에 있는 "자택정보이력정보" 표(정보갱신일 | 주소 | 휴대폰번호)에서
가장 마지막(최신) 행의 주소·휴대폰번호를 채택한다. 이 표를 못 찾으면 기존 방식대로
"주소" 라벨 뒤 텍스트를 정규식으로 찾는 것으로 폴백한다.

실제 문서로 로컬 테스트를 할 수 없는 환경에서 작성된 1차 버전이라 debugRows에
파싱된 전체 행을 같이 내려준다 — 값이 이상하면 이걸 같이 확인해서 컬럼 판정
로직/조회일자 라벨을 튜닝한다.
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile


MAX_PAGES = 5
ADDR_HINT = r'(?:특별시|광역시|자치시|자치도|[가-힣]{1,2}도)'
DATE_ISO_RE = re.compile(r'\d{4}[.\-]\d{1,2}[.\-]\d{1,2}')
PHONE_RE = re.compile(r'01[016789][-\s]?\d{3,4}[-\s]?\d{4}')
QUERY_LABELS = ("조회일자", "조회일", "발급일자", "발급일", "출력일자", "출력일")

HEADER_LABELS = {"정보갱신일", "주소", "휴대폰번호", "휴대폰"}


def _clean(s):
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'[,\.]+$', '', s).strip()
    return s


def find_address(text):
    """기존 방식: '주소' 라벨 뒤 텍스트 — 표를 못 찾았을 때의 폴백."""
    if not text:
        return None
    for m in re.finditer(r'(?<!이메일)(?<!메일)주\s*소\s*[:：]?\s*([^\n]{5,80})', text):
        cand = _clean(m.group(1))
        if re.search(ADDR_HINT, cand) or re.search(r'[가-힣]+(?:시|군|구)\s?[가-힣0-9]+(?:동|읍|면|로|길)', cand):
            return cand[:80]
    m = re.search(r'([가-힣]+' + ADDR_HINT + r'\s?[가-힣0-9]+(?:시|군|구)\s?[가-힣0-9]+(?:동|읍|면|로|길)[^\n]{0,40})', text)
    if m:
        return _clean(m.group(1))[:80]
    return None


def find_queried_date(text):
    if not text:
        return None
    for label in QUERY_LABELS:
        m = re.search(re.escape(label) + r'\s*[:：]?\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})', text)
        if m:
            y, mo, d = m.groups()
            return f"{y}-{int(mo):02d}-{int(d):02d}"
    # 라벨을 못 찾으면 문서 상단 1/3 영역(대략 앞부분 텍스트)의 첫 날짜로 폴백
    head = text[:len(text) // 3] if len(text) > 30 else text
    m = re.search(r'(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})', head)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    return None


def _rect_xy(rect):
    x = getattr(rect, "x", None)
    if x is None:
        x = getattr(rect, "X", 0)
    y = getattr(rect, "y", None)
    if y is None:
        y = getattr(rect, "Y", 0)
    return x, y


def _looks_like_address(s):
    s = s.strip()
    if len(s) < 4:
        return False
    if re.search(ADDR_HINT, s):
        return True
    if re.search(r'[가-힣]+(?:시|군|구)\s?[가-힣0-9]*(?:동|읍|면|로|길)', s):
        return True
    return False


def parse_home_history_table(pages_words):
    """
    pages_words: [[(word_text, left_x, top_y), ...], ...] (단어 단위, 인식 순서 그대로)
    "자택정보이력정보" 표: 정보갱신일 | 주소 | 휴대폰번호 3컬럼.
    반환: [{date, address, phone}, ...] — 마지막 항목이 최신.
    """
    date_col_x = None
    addr_col_x = None
    phone_col_x = None
    for words in pages_words:
        for text, x, y in words:
            if date_col_x is None and "정보갱신일" in text:
                date_col_x = x
            if addr_col_x is None and text.strip() == "주소":
                addr_col_x = x
            if phone_col_x is None and "휴대폰" in text:
                phone_col_x = x
        if date_col_x is not None and phone_col_x is not None:
            break

    if date_col_x is None or phone_col_x is None:
        return []
    if addr_col_x is None:
        addr_col_x = (date_col_x + phone_col_x) / 2

    rows = []
    pending_addr = []
    for words in pages_words:
        for text, x, y in words:
            raw = text.strip()
            if not raw or raw in HEADER_LABELS:
                continue

            if x < addr_col_x - 15:
                m_date = DATE_ISO_RE.search(raw)
                if m_date:
                    addr = re.sub(r'\s+', ' ', " ".join(pending_addr)).strip()
                    pending_addr = []
                    rows.append({
                        "date": m_date.group().replace(".", "-"),
                        "address": addr[:80] if _looks_like_address(addr) else None,
                        "phone": None,
                    })
                continue

            if addr_col_x - 15 <= x < phone_col_x - 15:
                pending_addr.append(raw)
                continue

            m_phone = PHONE_RE.search(raw)
            if m_phone and rows:
                rows[-1]["phone"] = m_phone.group().replace(" ", "")

    return rows


async def ocr_pdf(pdf_path):
    import winrt.windows.media.ocr as winrt_ocr
    import winrt.windows.storage as winrt_storage
    import winrt.windows.graphics.imaging as winrt_imaging
    import winrt.windows.globalization as winrt_glob

    lang = winrt_glob.Language("ko-KR")
    engine = winrt_ocr.OcrEngine.try_create_from_language(lang)
    if engine is None:
        return {"ok": False, "error": "한국어 OCR 엔진 없음"}

    doc = fitz.open(pdf_path)
    tmp_files = []
    all_page_words = []
    first_page_text = ""
    fallback_address = None

    try:
        n_pages = min(MAX_PAGES, doc.page_count)
        for page_num in range(n_pages):
            page = doc[page_num]
            mat = fitz.Matrix(3, 3)
            pix = page.get_pixmap(matrix=mat)

            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                tmp_path = f.name
            tmp_files.append(tmp_path)
            pix.save(tmp_path)

            abs_path = os.path.abspath(tmp_path)
            file = await winrt_storage.StorageFile.get_file_from_path_async(abs_path)
            stream = await file.open_async(winrt_storage.FileAccessMode.READ)
            decoder = await winrt_imaging.BitmapDecoder.create_async(stream)
            bitmap = await decoder.get_software_bitmap_async()
            result = await engine.recognize_async(bitmap)
            text = result.text

            if page_num == 0:
                first_page_text = text
            if fallback_address is None:
                fallback_address = find_address(text)

            page_words = []
            try:
                for line in result.lines:
                    for w in line.words:
                        wx, wy = _rect_xy(w.bounding_rect)
                        page_words.append((w.text, wx, wy))
            except Exception:
                page_words = []
            all_page_words.append(page_words)

        queried_date = find_queried_date(first_page_text)

        try:
            table = parse_home_history_table(all_page_words)
        except Exception:
            table = []

        last_row = table[-1] if table else None
        address = (last_row["address"] if last_row and last_row.get("address") else None) or fallback_address
        phone = last_row["phone"] if last_row else None

        if not address:
            return {"ok": False, "error": "주소 없음", "phone": phone, "queriedDate": queried_date, "debugRows": table}

        return {
            "ok": True,
            "address": address,
            "phone": phone,
            "queriedDate": queried_date,
            "debugRows": table,
        }

    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        doc.close()
        for f in tmp_files:
            try:
                os.unlink(f)
            except Exception:
                pass


def main():
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": "PDF 경로 필요"}, ensure_ascii=True).encode("ascii"))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": "파일 없음"}, ensure_ascii=True).encode("ascii"))
        sys.exit(1)

    result = asyncio.run(ocr_pdf(pdf_path))
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
