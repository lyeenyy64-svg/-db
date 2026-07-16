"""
CB종합보고서 PDF에서 최신 주소지·연락처(휴대폰)·조회일자 추출 (Windows OCR)
사용법: python ocr_credit_address.py <pdf_path>
출력: JSON {
  "ok": true, "address": "서울특별시 ...", "phone": "010-0000-0000",
  "queriedDate": "2026-07-10"
} 또는 {"ok": false, "error": "..."}

보통 3페이지 근처에 있는 "자택정보이력정보" 표(정보갱신일 | 주소 | 휴대폰번호)에서
가장 마지막(최신) 행의 주소·휴대폰번호를 채택한다. 이 표를 못 찾으면 기존 방식대로
"주소" 라벨 뒤 텍스트를 정규식으로 찾는 것으로 폴백한다.

주민등록초본(ocr_resident.py)에서 실 서버 테스트로 확인한 것처럼, Windows OCR은
표를 "세로 컬럼" 단위로 통째로 먼저 읽기 때문에 순서(주소 다음에 날짜)에 의존하지
않고 좌표(x, y)만으로 같은 행을 판정한다 (find_last_home_row 참고).
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


def _cluster_x(xs, gap=60):
    """정렬된 x값들을 gap 이내로 묶어서 [[x, x, ...], ...] 클러스터 목록으로 반환."""
    if not xs:
        return []
    xs = sorted(xs)
    clusters = [[xs[0]]]
    for x in xs[1:]:
        if x - clusters[-1][-1] <= gap:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return clusters


def find_last_home_row(pages_words):
    """
    pages_words: [[(word_text, left_x, top_y), ...], ...] (단어 단위, 인식 순서 그대로)
    "자택정보이력정보" 표: 정보갱신일 | 주소 | 휴대폰번호 3컬럼.

    주민등록초본 표에서 실 서버 테스트로 확인한 것과 동일한 문제 — Windows OCR이
    표를 "세로 컬럼" 단위로 통째로 먼저 읽어서 순서(주소 다음에 날짜)에 의존할 수
    없다 — 이 여기도 똑같이 적용된다고 보고, 순서 대신 좌표(x, y)로만 같은 행을
    판정한다. 표 제목("정보갱신일"/"주소"/"휴대폰번호") 글자에는 의존하지 않는다.
    반환: {"address", "date", "phone"} 또는 표를 못 찾으면 None.
    """
    raw_entries = []  # (y, x, text) — 원래 인식 순서 그대로
    for words in pages_words:
        for text, x, y in words:
            raw = text.strip()
            if raw:
                raw_entries.append((y, x, raw))

    # 여러 단어에 걸친 "[...]" 안내문구는 중간 단어만 보면 걸러낼 수 없어서, 원래
    # 순서대로 훑어 여는/닫는 괄호 구간 전체를 통째로 제거한다 (ocr_resident.py와 동일).
    all_entries = []
    in_bracket = False
    for e in raw_entries:
        text = e[2]
        if not in_bracket and text.startswith("["):
            in_bracket = True
        if in_bracket:
            if "]" in text:
                in_bracket = False
            continue
        all_entries.append(e)

    date_matches = [(y, x, DATE_ISO_RE.search(text).group().replace(".", "-"))
                    for y, x, text in all_entries if DATE_ISO_RE.search(text)]
    if not date_matches:
        return None
    date_clusters = _cluster_x([x for _, x, _ in date_matches])
    date_best = max(date_clusters, key=lambda c: sum(1 for _, x, _ in date_matches if c[0] - 5 <= x <= c[-1] + 5))
    date_lo, date_hi = date_best[0] - 15, date_best[-1] + 15

    date_col = [(y, v) for y, x, v in date_matches if date_lo <= x <= date_hi]
    if not date_col:
        return None
    date_col.sort(key=lambda e: e[0])
    last_y, last_date = date_col[-1]

    # 위쪽 경계: 바로 이전 행의 날짜 y와 이번 행의 날짜 y 중간점까지만 — 고정폭을 쓰면
    # 행 간격보다 넓어서 이전 행 주소가 섞여 들어올 수 있다.
    TOL = 70
    if len(date_col) >= 2:
        prev_y = date_col[-2][0]
        y_min = prev_y + (last_y - prev_y) / 2
    else:
        y_min = last_y - TOL
    y_max = last_y + TOL

    phone_matches = [(y, x, PHONE_RE.search(text).group().replace(" ", ""))
                     for y, x, text in all_entries if PHONE_RE.search(text) and x > date_hi]
    phone_lo = None
    if phone_matches:
        phone_clusters = _cluster_x([x for _, x, _ in phone_matches])
        phone_best = max(phone_clusters, key=lambda c: sum(1 for _, x, _ in phone_matches if c[0] - 5 <= x <= c[-1] + 5))
        phone_lo = phone_best[0] - 15

    def _collect(min_x=None, max_x=None):
        # 같은 시각적 줄(±20px 이내)끼리 묶은 뒤, 그 안에서는 x(좌→우) 순서로 정렬
        words = [(round(y / 20) * 20, x, text) for y, x, text in all_entries
                 if y_min <= y <= y_max
                 and (min_x is None or x >= min_x) and (max_x is None or x < max_x)
                 and text not in HEADER_LABELS]
        words.sort(key=lambda e: (e[0], e[1]))
        return " ".join(t for _, _, t in words)

    addr_raw = _collect(min_x=date_hi + 10, max_x=phone_lo)
    address = re.sub(r'\s+', ' ', addr_raw).strip()
    if not _looks_like_address(address):
        address = None

    phone = None
    if phone_lo is not None:
        candidates = [(y, v) for y, x, v in phone_matches if y_min <= y <= y_max]
        if candidates:
            candidates.sort(key=lambda e: abs(e[0] - last_y))
            phone = candidates[0][1]

    return {"address": address[:80] if address else None, "date": last_date, "phone": phone}


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
            last_row = find_last_home_row(all_page_words)
        except Exception:
            last_row = None

        address = (last_row["address"] if last_row and last_row.get("address") else None) or fallback_address
        phone = last_row["phone"] if last_row else None

        if not address:
            return {"ok": False, "error": "주소 없음", "phone": phone, "queriedDate": queried_date}

        return {
            "ok": True,
            "address": address,
            "phone": phone,
            "queriedDate": queried_date,
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
