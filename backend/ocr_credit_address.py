"""
CB종합보고서 PDF에서 최신 주소지 추출 (Windows OCR)
사용법: python ocr_credit_address.py <pdf_path>
출력: JSON {"ok": true, "address": "서울특별시 ..."} 또는 {"ok": false, "error": "..."}
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile


ADDR_HINT = r'(?:특별시|광역시|자치시|자치도|[가-힣]{1,2}도)'


def _clean(s):
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'[,\.]+$', '', s).strip()
    return s


def find_address(text):
    if not text:
        return None

    # 패턴 1: "주소" 라벨 뒤에 실제 주소가 이어지는 경우 (이메일주소 오탐 방지)
    for m in re.finditer(r'(?<!이메일)(?<!메일)주\s*소\s*[:：]?\s*([^\n]{5,80})', text):
        cand = _clean(m.group(1))
        if re.search(ADDR_HINT, cand) or re.search(r'[가-힣]+(?:시|군|구)\s?[가-힣0-9]+(?:동|읍|면|로|길)', cand):
            return cand[:80]

    # 패턴 2: 라벨 없이 본문 중 전형적인 한국 주소 형태를 직접 탐색
    m = re.search(r'([가-힣]+' + ADDR_HINT + r'\s?[가-힣0-9]+(?:시|군|구)\s?[가-힣0-9]+(?:동|읍|면|로|길)[^\n]{0,40})', text)
    if m:
        return _clean(m.group(1))[:80]

    return None


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

    try:
        # 주소는 보통 앞쪽 기본정보 페이지에 있음 — 최대 2페이지까지 스캔
        for page_num in range(min(2, doc.page_count)):
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

            address = find_address(text)
            if address:
                return {"ok": True, "address": address}

        return {"ok": False, "error": "주소 없음"}

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
