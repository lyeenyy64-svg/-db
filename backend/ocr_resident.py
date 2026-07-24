"""
주민등록초본 PDF에서 주민등록번호·최근 주소·등록일(신고일)·비고(세대주및관계)·발급일 추출 (PaddleOCR)
사용법: python ocr_resident.py <pdf_path>
출력: JSON {
  "ok": true, "number": "930624-1241111",
  "address": "...", "registeredDate": "2024-04-03", "note": "박서훈의 배우자",
  "issuedDate": "2025-01-03"
} 또는 {"ok": false, "error": "..."}

Windows OCR(winrt) 대신 PaddleOCR을 쓴다 — 실 서버 비교 테스트에서 한글 인식 정확도가
눈에 띄게 높았다(문장이 토막나지 않고 온전하게 인식됨). PaddleOCR은 텍스트를 줄/구 단위
박스로 인식해서(자세한 설명은 paddle_ocr_engine.py 참고) Windows OCR처럼 값이 여러
단어로 쪼개지는 경우가 windows OCR 대비 훨씬 적지만, 표 안에서 "주소 다음에 날짜가
나온다"는 순서 가정은 여전히 성립하지 않을 수 있어(칸 단위로 인식되므로) 아래
find_last_history_row는 기존과 동일하게 각 텍스트 박스의 x/y 좌표만으로 같은 행을 판정한다.
"""
import sys
import os
import re
import json
from paddle_ocr_engine import ocr_pdf_pages

MAX_PAGES = 6
ADDR_HINT = r'(?:특별시|광역시|자치시|자치도|[가-힣]{1,2}도)'
DATE_ISO_RE = re.compile(r'\d{4}[-.]\d{2}[-.]\d{2}')
DATE_KOR_RE = re.compile(r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일')

NOISE_KEYWORDS = ("이전내용", "생략", "위 용지는", "이 용지는")
HEADER_LABELS = {"번호", "주소", "성명", "생년월일", "발생일", "신고일", "세대주및관계", "등록상태", "세대주및 관계"}
STATUS_WORDS = ("거주자", "전입", "말소", "세대주변경", "행정구역변경", "도로명주소", "재등록", "직권")
# 주소이력 표의 마지막 행이 페이지 하단과 가까우면, 그 아래 "발급 신청 정보"
# 영역(담당자/신청인/용도 및 목적 등)까지 y범위에 걸려서 주소·비고에 그대로
# 섞여 들어오는 경우가 실 서버 데이터에서 확인됨 — 이 라벨이 섞여 있으면
# 표 데이터가 아니라 신청 정보이므로 통째로 버린다.
FOOTER_NOISE_RE = re.compile(r'담당자|신청인|용도\s*및\s*목적|접수자|발급자')


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


HANJA_RE = re.compile(r'[一-鿿]')


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
    # 등록된 주소엔 한자가 나올 일이 없다 — "성명(한자)"처럼 세대원 이름을 한자와 함께
    # 표기한 부분이 OCR 박스 분할 때문에 "성명" 같은 정확한 라벨 문자열로 안 걸러지고
    # 주소/비고 칸에 그대로 섞여 들어오는 경우가 실제로 확인됨(예: "노유나 (魯唯娜"),
    # 한자가 포함된 단어는 통째로 노이즈로 간주해 걸러낸다.
    if HANJA_RE.search(t):
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


def find_last_history_row(pages_words):
    """
    pages_words: [[(word_text, left_x, top_y), ...], ...] 페이지 순서.

    실제 서버 테스트로 확인한 사실: Windows OCR은 표를 "줄" 단위가 아니라
    "세로 컬럼" 단위로 통째로 먼저 읽는다 (주소 컬럼 전체를 위→아래로 다 읽은 뒤에야
    날짜 컬럼을 읽는 식) — 그래서 "주소 다음에 날짜가 나온다"는 순서 가정은 성립하지
    않는다. 대신 좌표(x, y)만으로 같은 행을 판정한다:
      1) YYYY-MM-DD 패턴이 있는 단어들의 x좌표 중, 가장 많이 반복되는 x구간을
         "신고일" 컬럼으로 채택한다 (발생일 컬럼은 빈 칸(-----)이 많아 매칭 수가 적다).
      2) 그 컬럼에서 페이지·y좌표 기준으로 가장 마지막(아래쪽) 날짜를 "최근 등록일"로 삼는다.
      3) 그 날짜와 같은 y 근처(위쪽 주소 컬럼)의 텍스트를 모아 주소로, 오른쪽(비고 컬럼)
         텍스트를 모아 비고로 삼는다.
    표 제목("발생일"/"신고일"/"세대주및관계") 글자 자체는 작아서 OCR이 놓치는 경우가
    많아 컬럼 판정에 쓰지 않는다.
    반환: {"address", "date", "note"} 또는 표를 못 찾으면 None.
    """
    raw_entries = []  # (page_idx, y, x, text) — 원래 인식 순서 그대로
    for p_idx, words in enumerate(pages_words):
        for text, x, y in words:
            raw = text.strip()
            if raw:
                raw_entries.append((p_idx, y, x, raw))

    # "[법률9774호(...) 도로명주소법, 공법관계의 주소변경]" 같은 안내문구는 여러 단어에
    # 걸쳐 나오는데, 그중 중간 단어들은 "["로 시작하지도 "]"를 포함하지도 않아 단어
    # 하나씩만 보고는 걸러낼 수 없다 — 원래 순서대로 훑어서 여는/닫는 괄호 "구간
    # 전체"를 통째로 제거해야 한다 (마지막 행의 y범위가 이 안내문구와 겹치는 경우
    # 실제로 주소에 이 문구가 섞여 들어온 적이 있어 반드시 필요한 전처리).
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

    date_matches = []  # (page_idx, y, x, date_val)
    for p_idx, y, x, text in all_entries:
        m = DATE_ISO_RE.search(text)
        if m:
            date_matches.append((p_idx, y, x, m.group().replace(".", "-")))
    if not date_matches:
        return None

    clusters = _cluster_x([x for _, _, x, _ in date_matches])
    best = max(clusters, key=lambda c: sum(1 for _, _, x, _ in date_matches if c[0] - 5 <= x <= c[-1] + 5))
    date_lo, date_hi = best[0] - 15, best[-1] + 15

    date_col = [(p, y, v) for p, y, x, v in date_matches if date_lo <= x <= date_hi]
    if not date_col:
        return None
    date_col.sort(key=lambda e: (e[0], e[1]))
    last_page, last_y, last_date = date_col[-1]

    # 위쪽 경계: 바로 이전 행의 날짜 y와 이번 행의 날짜 y 중간점까지만 — 이렇게 해야
    # 행 간격(보통 100px 이상)보다 넓은 고정폭을 쓰다가 이전 행 주소가 섞여 들어오는
    # 문제를 막을 수 있다. 이전 행이 없으면(첫 행) 고정폭 70px을 그대로 쓴다.
    TOL = 70
    prev_same_page = [(p, y) for p, y, v in date_col[:-1] if p == last_page]
    if prev_same_page:
        prev_y = prev_same_page[-1][1]
        y_min = prev_y + (last_y - prev_y) / 2
    else:
        y_min = last_y - TOL
    y_max = last_y + TOL

    def _collect(min_x=None, max_x=None):
        # 같은 시각적 줄(±20px 이내)끼리 묶은 뒤, 그 안에서는 x(좌→우) 순서로 정렬
        # — 순수 y정렬만 쓰면 거의 같은 높이인 단어들의 좌우 순서가 뒤섞일 수 있다.
        words = [(round(y / 20) * 20, x, text) for p, y, x, text in all_entries
                 if p == last_page and y_min <= y <= y_max
                 and (min_x is None or x >= min_x) and (max_x is None or x < max_x)
                 and not text.startswith("[") and "]" not in text]
        words.sort(key=lambda e: (e[0], e[1]))
        return " ".join(t for _, _, t in words)

    addr_raw = _collect(max_x=date_lo - 10)
    addr_words = [w for w in addr_raw.split() if not _is_noise_word(w)]
    address = re.sub(r'\s+', ' ', " ".join(addr_words)).strip()
    if not _looks_like_address(address) or FOOTER_NOISE_RE.search(address):
        address = None

    note_raw = _collect(min_x=date_hi + 10)
    note_words = [w for w in note_raw.split()
                  if w not in HEADER_LABELS and not any(s in w for s in STATUS_WORDS) and not HANJA_RE.search(w)]
    note = re.sub(r'\s+', ' ', " ".join(note_words)).strip() or None
    if note and FOOTER_NOISE_RE.search(note):
        note = None

    return {"address": address[:80] if address else None, "date": last_date, "note": note}


def ocr_pdf(pdf_path):
    try:
        all_page_words, first_page_text = ocr_pdf_pages(pdf_path, MAX_PAGES)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # 페이지 전체 텍스트를 이어붙여서 찾는다 — 주민등록번호가 1페이지가 아니라
    # 다른 페이지에 있는 문서도 있을 수 있어 모든 페이지를 훑는다.
    number = None
    for page_words in all_page_words:
        flat = " ".join(t for t, _, _ in page_words)
        number = find_resident_number(flat)
        if number:
            break

    issued_date = None
    kor_dates = DATE_KOR_RE.findall(first_page_text)
    if len(kor_dates) == 1:
        y, mo, d = kor_dates[0]
        issued_date = f"{y}-{int(mo):02d}-{int(d):02d}"

    try:
        last_row = find_last_history_row(all_page_words)
    except Exception:
        last_row = None

    return {
        "ok": bool(number),
        "number": number,
        "address": last_row["address"] if last_row else None,
        "registeredDate": last_row["date"] if last_row else None,
        "note": (last_row["note"] if last_row and last_row["note"] else None),
        "issuedDate": issued_date,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "PDF 경로 필요"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(json.dumps({"ok": False, "error": "파일 없음"}))
        sys.exit(1)

    result = ocr_pdf(pdf_path)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
