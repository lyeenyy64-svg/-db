"""
주민등록초본 PDF에서 주민등록번호 추출 (Windows OCR)
사용법: python ocr_resident.py <pdf_path>
출력: JSON {"ok": true, "number": "930624-1241111"} 또는 {"ok": false, "error": "..."}
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile

def find_resident_number(text):
    if not text:
        return None
    # 직접 매칭 (하이픈 또는 en-dash)
    m = re.search(r'\d{6}[-–]\d{7}', text)
    if m:
        return re.sub(r'[^\d-]', '', m.group().replace('–', '-'))
    # 공백 제거 후
    compact = re.sub(r'\s+', '', text)
    m = re.search(r'\d{6}[-–]\d{7}', compact)
    if m:
        return re.sub(r'[^\d-]', '', m.group().replace('–', '-'))
    # 공백 허용 매칭
    m = re.search(r'\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]*[-–][\s]*\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d[\s]?\d', text)
    if m:
        cleaned = re.sub(r'[\s]', '', m.group()).replace('–', '-')
        if re.fullmatch(r'\d{6}-\d{7}', cleaned):
            return cleaned
    # 13자리 연속 숫자 (하이픈 없음)
    m = re.search(r'\b(\d{6})(\d{7})\b', compact)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
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
        for page_num in range(min(2, doc.page_count)):
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

            number = find_resident_number(text)
            if number:
                return {"ok": True, "number": number}

        return {"ok": False, "error": "번호 없음"}

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
        print(json.dumps({"ok": False, "error": "PDF 경로 필요"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(json.dumps({"ok": False, "error": "파일 없음"}))
        sys.exit(1)

    result = asyncio.run(ocr_pdf(pdf_path))
    # ASCII-safe JSON 출력
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    sys.stdout.buffer.write(b"\n")

if __name__ == "__main__":
    main()
