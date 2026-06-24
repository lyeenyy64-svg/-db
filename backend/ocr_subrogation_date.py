"""
대위변제증명서 PDF에서 대위변제일 추출 (Windows OCR)
사용법: python ocr_subrogation_date.py <pdf_path>
출력: JSON {"ok": true, "date": "2026.03.31"} 또는 {"ok": false, "error": "..."}
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile


def find_subrogation_date(text):
    if not text:
        return None

    # 모든 날짜 후보 수집
    candidates = []

    # 패턴 1: YYYY년 M(M)월 D(D)일
    for m in re.finditer(r'(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일', text):
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        candidates.append((m.start(), f"{y}.{mo}.{d}"))

    # 패턴 2: YYYY. MM. DD. 또는 YYYY. M. D.
    for m in re.finditer(r'(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?', text):
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        if 2000 <= int(y) <= 2099 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
            candidates.append((m.start(), f"{y}.{mo}.{d}"))

    # 패턴 3: YYYY-MM-DD
    for m in re.finditer(r'(\d{4})-(\d{2})-(\d{2})', text):
        y, mo, d = m.group(1), m.group(2), m.group(3)
        if 2000 <= int(y) <= 2099:
            candidates.append((m.start(), f"{y}.{mo}.{d}"))

    if not candidates:
        return None

    # 대위변제 관련 텍스트 근처 우선
    priority_keywords = ['대위변제', '변제하였음', '증명함', '증명합니다']
    for kw in priority_keywords:
        idx = text.find(kw)
        if idx >= 0:
            # 해당 키워드 앞뒤 200자 범위 내 날짜 우선
            near = [(pos, dt) for pos, dt in candidates if abs(pos - idx) <= 200]
            if near:
                near.sort(key=lambda x: abs(x[0] - idx))
                return near[0][1]

    # 없으면 첫 번째 날짜 반환
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


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
    all_text = ""

    try:
        for page_num in range(min(3, doc.page_count)):
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
            all_text += result.text + "\n"

        date = find_subrogation_date(all_text)
        if date:
            return {"ok": True, "date": date}
        return {"ok": False, "error": "날짜 없음"}

    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        doc.close()
        for f in tmp_files:
            try:
                os.unlink(f)
            except:
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
