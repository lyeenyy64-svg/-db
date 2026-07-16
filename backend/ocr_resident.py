"""
주민등록초본 PDF에서 주민등록번호·최근 주소·등록일(신고일)·비고(세대주및관계)·발급일 추출 (Windows OCR)
사용법: python ocr_resident.py <pdf_path>
출력: JSON {
  "ok": true, "number": "930624-1241111",
  "address": "...", "registeredDate": "2024-04-03", "note": "박서훈의 배우자",
  "issuedDate": "2025-01-03", "debugRows": [...]
} 또는 {"ok": false, "error": "..."}

주소이력표(주소/발생일·신고일/세대주및관계·등록상태)는 여러 줄이 쌓이는 구조라,
OCR 결과의 단어(word) 단위 좌표(bounding_rect)를 이용해 컬럼을 나누고, 표의
가장 마지막 행을 "최근 주소"로 채택한다. 실제 문서로 로컬 테스트를 할 수 없는
환경에서 작성된 1차 버전이라 debugRows에 파싱된 전체 행을 같이 내려준다 —
값이 이상하면 이걸 같이 확인해서 컬럼 판정 로직을 튜닝한다.
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile

MAX_PAGES = 6
ADDR_HINT = r'(?:특별시|광역시|자치시|자치도|[가-힣]{1,2}도)'
DATE_ISO_RE = re.compile(r'\d{4}[-.]\d{2}[-.]\d{2}')
DATE_KOR_RE = re.compile(r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일')

NOISE_KEYWORDS = ("이전내용", "생략", "위 용지는", "이 용지는")
HEADER_LABELS = {"번호", "주소", "성명", "생년월일", "발생일", "신고일", "세대주및관계", "등록상태", "세대주및 관계"}
STATUS_WORDS = ("거주자", "전입", "말소", "세대주변경", "행정구역변경", "도로명주소", "재등록", "직권")


def find_resident_number(text):
    if not text:
        return None
    m = re.search(r'\d{6}[-–]\d{7}', text)
    if m:
        return re.sub(r'[^\d-]', '', m.group().replace('–', '-'))
    compact = re.sub(r'\s+', '', text)
    m = re.search(r'\d{6}[-–]\d{7}', compact)
    if m:
        return re.sub(r'[^\d-]', '', m.group().replace('–', '-'))
    m = re.search(r'\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]*[-–][\s]*\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d', text)
    if m:
        cleaned = re.sub(r'[\s]', '', m.group()).replace('–', '-')
        if re.fullmatch(r'\d{6}-\d{7}', cleaned):
            return cleaned
    m = re.search(r'\b(\d{6})(\d{7})\b', compact)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return None


def _rect_xy(rect):
    x = getattr(rect, "x", None)
    if x is None:
        x = getattr(rect, "X", 0)
    y = getattr(rect, "y", None)
    if y is None:
        y = getattr(rect, "Y", 0)
    return x, y


def _is_noise_word(t):
    t = t.strip()
    if not t:
        return True
    if t in HEADER_LABELS:
        return True
    if any(k in t for k in NOISE_KEYWORDS):
        return True
    if re.fullmatch(r'\d{1,3}', t):
        return True
    return False


def _looks_like_address(s):
    s = s.strip()
    if len(s) < 4:
        return False
    if re.search(ADDR_HINT, s):
        return True
    if re.search(r'[가-힣]+(?:시|군|구)\s?[가-힣0-9]*(?:동|읍|면|로|길)', s):
        return True
    return False


def _median(nums):
    if not nums:
        return None
    s = sorted(nums)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 == 1 else (s[mid - 1] + s[mid]) / 2


def parse_history_table(pages_words):
    """
    pages_words: [[(word_text, left_x, top_y), ...], ...] 페이지 순서, 각 페이지는
    단어(word) 단위 OCR 인식 순서(대략 위→아래, 좌→우) 그대로.

    표 제목("발생일"/"신고일"/"세대주및관계"/"등록상태")은 작은 글자라 OCR이 놓치는
    경우가 많아서, 제목 글자에 기대지 않고 실제 데이터(날짜 패턴 YYYY-MM-DD, 등록상태
    키워드)의 x좌표로 컬럼 경계를 추정한다 — 날짜·상태 값은 표에 여러 번 반복 등장해서
    제목 글자 하나보다 인식 실패 확률이 훨씬 낮다.
    반환: [{address, date, note}, ...] — 표에 나온 순서대로, 마지막 항목이 최신 주소.
    """
    all_words = [w for words in pages_words for w in words]

    date_xs = [x for text, x, y in all_words if DATE_ISO_RE.search(text.strip())]
    if not date_xs:
        return []
    date_col_x = _median(date_xs)

    status_xs = [x for text, x, y in all_words
                 if x > date_col_x + 10 and any(w in text.strip() for w in STATUS_WORDS)]
    status_col_x = _median(status_xs) if status_xs else (date_col_x + 250)
    note_col_x = date_col_x + 15

    rows = []
    pending = []
    in_bracket = False
    for words in pages_words:
        for text, x, y in words:
            raw = text.strip()
            if not raw:
                continue

            # "[법률9774호(...) 도로명주소법, 공법관계의 주소변경]" 같은 안내문구는
            # 여러 단어에 걸쳐 나오므로, 여는/닫는 괄호 사이 전체를 건너뛴다.
            if not in_bracket and raw.startswith("["):
                in_bracket = True
            if in_bracket:
                if "]" in raw:
                    in_bracket = False
                continue

            m = DATE_ISO_RE.search(raw)
            if m and (date_col_x - 25) <= x <= (date_col_x + 25):
                date_val = m.group().replace(".", "-")
                addr = re.sub(r'\s+', ' ', " ".join(pending)).strip()
                pending = []
                if addr and _looks_like_address(addr):
                    rows.append({"address": addr[:80], "date": date_val, "note": ""})
                elif rows:
                    # 같은 행의 두 번째 날짜(신고일) — 앞서 만든 행의 날짜를 최종값으로 갱신
                    rows[-1]["date"] = date_val
                continue

            if x < date_col_x - 25:
                if not _is_noise_word(raw):
                    pending.append(raw)
                continue

            if note_col_x <= x < status_col_x - 10:
                if rows and raw not in HEADER_LABELS and not any(w in raw for w in STATUS_WORDS):
                    rows[-1]["note"] = (rows[-1]["note"] + " " + raw).strip() if rows[-1]["note"] else raw
                continue
            # x >= status_col_x - 10 → 등록상태 칸으로 판단해 무시

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
    number = None
    all_page_words = []
    first_page_text = ""

    try:
        n_pages = min(MAX_PAGES, doc.page_count)
        for page_num in range(n_pages):
            page = doc[page_num]
            mat = fitz.Matrix(3, 3)  # 3x 해상도
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
            if number is None:
                number = find_resident_number(text)

            page_words = []
            try:
                for line in result.lines:
                    for w in line.words:
                        wx, wy = _rect_xy(w.bounding_rect)
                        page_words.append((w.text, wx, wy))
            except Exception:
                page_words = []
            all_page_words.append(page_words)

        issued_date = None
        kor_dates = DATE_KOR_RE.findall(first_page_text)
        if len(kor_dates) == 1:
            y, mo, d = kor_dates[0]
            issued_date = f"{y}-{int(mo):02d}-{int(d):02d}"

        try:
            table = parse_history_table(all_page_words)
        except Exception:
            table = []

        last_row = table[-1] if table else None

        # 진단용: 페이지 0~1의 단어 목록을 좌표와 함께 그대로 내려준다 (실제 문서로
        # 로컬 테스트를 못 하는 환경이라, 표 인식이 틀렸을 때 이 원본 데이터를 보고
        # 컬럼 판정 로직을 고친다). 문제 해결 후 제거할 임시 필드.
        debug_words = []
        for p_idx in (0, 1):
            if p_idx < len(all_page_words):
                for text, x, y in all_page_words[p_idx]:
                    debug_words.append([p_idx, round(x), round(y), text])

        return {
            "ok": bool(number),
            "number": number,
            "address": last_row["address"] if last_row else None,
            "registeredDate": last_row["date"] if last_row else None,
            "note": (last_row["note"] if last_row and last_row["note"] else None),
            "issuedDate": issued_date,
            "debugRows": table,
            "debugWords": debug_words,
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
        print(json.dumps({"ok": False, "error": "PDF 경로 필요"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(json.dumps({"ok": False, "error": "파일 없음"}))
        sys.exit(1)

    result = asyncio.run(ocr_pdf(pdf_path))
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
