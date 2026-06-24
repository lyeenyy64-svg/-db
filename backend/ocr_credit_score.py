"""
CB종합보고서 PDF에서 신용점수 추출 (Windows OCR)
사용법: python ocr_credit_score.py <pdf_path>
출력: JSON {"ok": true, "score": "334"} 또는 {"ok": false, "error": "..."}
"""
import asyncio
import sys
import os
import re
import json
import fitz  # PyMuPDF
import tempfile


def find_credit_score(text):
    if not text:
        return None
    # 패턴 1: "N점 입니다" / "N점이며" / "N점이고" — 실제 점수를 나타내는 문맥
    m = re.search(r'(\d{3,4})\s*점\s*(?:입니다|이며|이고)', text)
    if not m:
        compact = re.sub(r'\s+', '', text)
        m = re.search(r'(\d{3,4})점(?:입니다|이며|이고)', compact)
    if m:
        score = int(m.group(1))
        if 150 <= score <= 999:
            return str(score)
    # 패턴 2: "신용수는 N점" / "신용점수 N점"
    compact = re.sub(r'\s+', '', text)
    m = re.search(r'신용[^\d]{0,15}(\d{3,4})점(?!기준)', compact)
    if m:
        score = int(m.group(1))
        if 150 <= score <= 999:
            return str(score)
    # 패턴 3: "N점" 단독 (1000점 기준 제외, 999 이하)
    for m in re.finditer(r'(\d{3,4})\s*점', text):
        score = int(m.group(1))
        if 150 <= score <= 999:
            # 뒤에 "기준"이 오면 제외
            after = text[m.end():m.end()+10]
            if '기준' not in after:
                return str(score)
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
        # 첫 페이지만 스캔 (CB보고서 점수는 1페이지에 있음)
        for page_num in range(min(1, doc.page_count)):
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

            score = find_credit_score(text)
            if score:
                return {"ok": True, "score": score}

        return {"ok": False, "error": "점수 없음"}

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
