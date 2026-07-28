"""
스캔본(이미지) PDF에서 전체 텍스트를 추출한다 (Windows OCR) — pdf-parse로 텍스트 추출이
안 되는(이미지로만 구성된) 문서를 "문건 분석" 기능에서 분석하기 위한 최후 수단.
사용법: python ocr_document_text.py <pdf_path>
출력: JSON {"ok": true, "text": "...", "pages": 12, "truncated": false} 또는 {"ok": false, "error": "..."}
"""
import asyncio
import sys
import os
import json
import fitz  # PyMuPDF

MAX_PAGES = 30  # 판결문 등 긴 문서도 감당하되, 끝없이 오래 걸리지 않도록 상한을 둔다


async def ocr_pdf(pdf_path):
    import winrt.windows.media.ocr as winrt_ocr
    import winrt.windows.storage as winrt_storage
    import winrt.windows.graphics.imaging as winrt_imaging
    import winrt.windows.globalization as winrt_glob
    import tempfile

    lang = winrt_glob.Language("ko-KR")
    engine = winrt_ocr.OcrEngine.try_create_from_language(lang)
    if engine is None:
        return {"ok": False, "error": "한국어 OCR 엔진 없음"}

    doc = fitz.open(pdf_path)
    tmp_files = []
    page_texts = []

    try:
        n_pages = min(MAX_PAGES, doc.page_count)
        for page_num in range(n_pages):
            page = doc[page_num]
            mat = fitz.Matrix(2.5, 2.5)
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
            page_texts.append(result.text or "")

        full_text = "\n\n".join(f"[페이지 {i + 1}]\n{t}" for i, t in enumerate(page_texts))
        return {
            "ok": bool(full_text.strip()),
            "text": full_text,
            "pages": n_pages,
            "truncated": doc.page_count > MAX_PAGES,
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
