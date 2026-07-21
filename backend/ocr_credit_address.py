"""
CB종합보고서 PDF에서 최신 주소지·연락처(휴대폰)·조회일자 추출 (PaddleOCR)
사용법: python ocr_credit_address.py <pdf_path>
출력: JSON {
  "ok": true, "address": "서울특별시 ...", "phone": "010-0000-0000",
  "queriedDate": "2026-07-10"
} 또는 {"ok": false, "error": "..."}

보통 3페이지 근처에 있는 "자택정보이력정보" 표(정보갱신일 | 우편번호 | 자택주소 |
자택전화번호 | 휴대폰번호 5컬럼)에서 가장 마지막(최신) 행의 주소·휴대폰번호를
채택한다. 이 표를 못 찾으면 기존 방식대로 "주소" 라벨 뒤 텍스트를 정규식으로
찾는 것으로 폴백한다.

Windows OCR(winrt) 대신 PaddleOCR을 쓴다(자세한 설명은 paddle_ocr_engine.py 참고) —
실 서버 비교 테스트에서 한글 인식 정확도가 훨씬 높았다. PaddleOCR은 값이 여러 박스로
쪼개지는 경우가 Windows OCR보다 훨씬 적지만, 완전히 없어졌다고 보장할 수는 없어서
아래 로직(행/페이지 단위로 묶은 뒤 여러 박스를 이어붙여 패턴을 찾는 방식,
find_last_home_row 참고)은 그대로 유지한다. 한 박스에 값이 통째로 들어있어도
_find_pattern_span이 첫 박스에서 바로 매칭되므로 동작에는 차이가 없다.
"""
import sys
import os
import re
import json
from paddle_ocr_engine import ocr_pdf_pages


MAX_PAGES = 5
ADDR_HINT = r'(?:특별시|광역시|자치시|자치도|[가-힣]{1,2}도)'
DATE_ISO_RE = re.compile(r'\d{4}[.\-]\d{1,2}[.\-]\d{1,2}')
PHONE_RE = re.compile(r'01[016789][-\s]?\d{3,4}[-\s]?\d{4}')
# 자택전화번호(지역번호 유선전화, 예: 02-2685-8025)까지 포함하는 넓은 전화번호 패턴.
# 우리가 CB에서 원하는 "연락처"는 휴대폰번호(PHONE_RE)뿐이지만, 유선전화도 주소
# 텍스트에서는 반드시 제외해야 한다 — 실 서버 데이터에서 유선전화가 PHONE_RE에는
# 안 걸려서 주소 뒤에 그대로 남아붙는 문제가 확인됨.
GENERAL_PHONE_RE = re.compile(r'0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}')
QUERY_LABELS = ("조회일자", "조회일", "발급일자", "발급일", "출력일자", "출력일")

HEADER_LABELS = {"정보갱신일", "주소", "휴대폰번호", "휴대폰"}
# 등록된 주소엔 한자가 나올 일이 없다 — 세대원/명의자 이름을 한자와 함께 표기한 부분이
# OCR 박스 분할 때문에 라벨 문자열로 안 걸러지고 주소 칸에 섞여 들어오는 경우가 있어
# (ocr_resident.py에서 실제로 확인된 문제, 여기도 동일하게 방어) 한자 포함 단어는 제외한다.
HANJA_RE = re.compile(r'[一-鿿]')


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


def _looks_like_address(s):
    s = s.strip()
    if len(s) < 4:
        return False
    if re.search(ADDR_HINT, s):
        return True
    if re.search(r'[가-힣]+(?:시|군|구)\s?[가-힣0-9]*(?:동|읍|면|로|길)', s):
        return True
    return False


POSTAL_RE = re.compile(r'^\d{5}$')


def _y_bands(entries, tol=20):
    """entries: [(page_idx, y, x, text), ...] (순서 무관). **같은 페이지 안에서만**
    y값 기준 tol 이내로 묶어서 [(page_idx, band_y, [(x, text), ...]), ...] 반환
    (각 band 내부는 x 오름차순). 페이지를 넘어 묶으면(예: 1페이지 하단 글자와
    3페이지 표 제목 글자가 우연히 비슷한 높이라 하나로 묶이는 경우) 전혀 관련
    없는 글자가 표 데이터에 섞여 들어가는 문제가 실 서버 테스트에서 확인됨 —
    반드시 페이지별로 나눠서 묶어야 한다."""
    if not entries:
        return []
    out = []
    by_page = {}
    for p, y, x, text in entries:
        by_page.setdefault(p, []).append((y, x, text))
    for p, page_entries in by_page.items():
        s = sorted(page_entries, key=lambda e: e[0])
        bands = [[s[0]]]
        for e in s[1:]:
            if e[0] - bands[-1][-1][0] <= tol:
                bands[-1].append(e)
            else:
                bands.append([e])
        for b in bands:
            avg_y = sum(e[0] for e in b) / len(b)
            items = sorted([(e[1], e[2]) for e in b], key=lambda t: t[0])
            out.append((p, avg_y, items))
    return out


def _find_pattern_span(items, pattern, max_words=6):
    """
    items: [(x, text), ...] (x 오름차순). 실 서버 테스트로 확인한 바, Windows OCR이
    "2023. 11. 16"이나 "010-7455-9195" 같은 값을 "2023." "11." "16" / "01"
    "0-7455-91" "95"처럼 여러 단어로 쪼개서 인식하는 경우가 있어, 단어 하나만 보고는
    정규식이 못 잡는다 — 그래서 연속된 단어를 공백 없이 이어붙여가며(최대 max_words개)
    패턴이 매칭되는 가장 앞쪽/가장 짧은 구간을 찾는다.
    반환: (matched_text, start_idx, end_idx) 또는 None.
    """
    n = len(items)
    for i in range(n):
        buf = ""
        for j in range(i, min(i + max_words, n)):
            buf += items[j][1]
            # search()가 아니라 match()를 쓴다 — search는 buf 어디든 패턴이 있으면
            # 성공으로 치기 때문에, 예를 들어 주소 단어에서 시작해도 계속 이어붙이다
            # 보면 결국 뒤쪽의 진짜 전화번호까지 buf에 포함되어 "그 주소 단어 위치에서
            # 전화번호를 찾았다"는 잘못된 결과가 나온다(실 서버 테스트에서 확인).
            # match()는 buf의 맨 앞부터 정확히 일치해야 하므로 이 오탐을 막는다.
            m = pattern.match(buf)
            if m:
                return (m.group(), i, j)
    return None


def _find_all_pattern_spans(items, pattern, skip=frozenset(), max_words=6):
    """_find_pattern_span과 같은 방식으로, 겹치지 않는 매칭을 모두 찾아 리스트로 반환한다.
    (한 행에 자택전화번호·휴대폰번호처럼 같은 패턴류가 두 개 이상 나올 수 있어서 필요)"""
    spans = []
    used = set(skip)
    n = len(items)
    for i in range(n):
        if i in used:
            continue
        buf = ""
        for j in range(i, min(i + max_words, n)):
            if j in used:
                break
            buf += items[j][1]
            m = pattern.match(buf)
            if m:
                spans.append((m.group(), i, j))
                used.update(range(i, j + 1))
                break
    return spans


def find_last_home_row(pages_words):
    """
    pages_words: [[(word_text, left_x, top_y), ...], ...] (단어 단위, 인식 순서 그대로)
    "자택정보이력정보" 표: 정보갱신일 | 우편번호 | 자택주소 | 자택전화번호 | 휴대폰번호.

    행(y)별로 묶은 뒤, 그 행 안에서 날짜·전화번호 패턴을 찾아 그 단어들을 빼고
    남은 것(우편번호·표 제목 제외)을 주소로 채택한다. 날짜가 있는 행 중 가장
    아래(y가 가장 큰) 행을 "최근" 행으로 삼는다.
    반환: {"address", "date", "phone"} 또는 표를 못 찾으면 None.
    """
    raw_entries = []  # (page_idx, y, x, text) — 원래 인식 순서 그대로
    for p_idx, words in enumerate(pages_words):
        for text, x, y in words:
            raw = text.strip()
            if raw:
                raw_entries.append((p_idx, y, x, raw))

    # 여러 단어에 걸친 "[...]" 안내문구는 중간 단어만 보면 걸러낼 수 없어서, 원래
    # 순서대로 훑어 여는/닫는 괄호 구간 전체를 통째로 제거한다 (ocr_resident.py와 동일).
    all_entries = []
    in_bracket = False
    for e in raw_entries:
        text = e[3]
        if not in_bracket and text.startswith("["):
            in_bracket = True
        if in_bracket:
            if "]" in text:
                in_bracket = False
            continue
        all_entries.append(e)

    bands = _y_bands(all_entries)

    best = None  # {"page", "y", "date", "address", "phone"}
    for page_idx, avg_y, items in bands:
        date_span = _find_pattern_span(items, DATE_ISO_RE)
        if not date_span:
            continue
        date_str, d_i, d_j = date_span

        used = set(range(d_i, d_j + 1))
        # 휴대폰번호(PHONE_RE)뿐 아니라 자택전화번호 같은 유선전화도 GENERAL_PHONE_RE로
        # 전부 찾아서 주소 후보에서 제외한다. 그중 휴대폰번호 형식과 일치하는 것만
        # "연락처"로 채택한다 — 유선전화가 주소 뒤에 그대로 남아붙는 문제 방지.
        phone_val = None
        for phone_str, p_i, p_j in _find_all_pattern_spans(items, GENERAL_PHONE_RE, skip=used):
            used |= set(range(p_i, p_j + 1))
            cleaned = phone_str.replace(" ", "")
            if phone_val is None and PHONE_RE.match(cleaned):
                phone_val = cleaned

        addr_words = [
            text for idx, (x, text) in enumerate(items)
            if idx not in used and text not in HEADER_LABELS and not POSTAL_RE.fullmatch(text)
            and not HANJA_RE.search(text)
        ]
        address_text = re.sub(r'\s+', ' ', " ".join(addr_words)).strip()

        row = {
            "page": page_idx,
            "y": avg_y,
            "date": date_str.replace(".", "-"),
            "address": address_text[:80] if _looks_like_address(address_text) else None,
            "phone": phone_val,
        }
        if best is None or (row["page"], row["y"]) > (best["page"], best["y"]):
            best = row

    if best is None:
        return None
    return {"address": best["address"], "date": best["date"], "phone": best["phone"]}


def ocr_pdf(pdf_path):
    try:
        all_page_words, first_page_text = ocr_pdf_pages(pdf_path, MAX_PAGES)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    fallback_address = find_address(first_page_text)
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


def main():
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": "PDF 경로 필요"}, ensure_ascii=True).encode("ascii"))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": "파일 없음"}, ensure_ascii=True).encode("ascii"))
        sys.exit(1)

    result = ocr_pdf(pdf_path)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
