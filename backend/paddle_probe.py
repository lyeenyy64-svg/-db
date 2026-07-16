"""
PaddleOCR 실제 설치 버전에서 인식 결과가 어떤 구조로 나오는지 확인하는 진단용 스크립트.
(paddleocr 2.x와 3.x는 호출 방식과 결과 구조가 달라서, 실제 서버에 설치된 버전 기준으로
결과를 직접 봐야 정확한 추출 스크립트를 짤 수 있다.)

사용법: python paddle_probe.py <pdf_path>
"""
import sys
import json
import fitz  # PyMuPDF


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "PDF 경로 필요"}))
        return

    pdf_path = sys.argv[1]
    img_path = pdf_path + "__probe.png"

    doc = fitz.open(pdf_path)
    page = doc[0]
    mat = fitz.Matrix(3, 3)
    pix = page.get_pixmap(matrix=mat)
    pix.save(img_path)
    doc.close()

    import paddleocr
    print("paddleocr version:", getattr(paddleocr, "__version__", "unknown"), file=sys.stderr)

    from paddleocr import PaddleOCR
    ocr = PaddleOCR(lang="korean")

    result = None
    used_method = None
    predict_error = None
    ocr_error = None
    try:
        result = ocr.predict(img_path)
        used_method = "predict"
    except Exception as e1:
        predict_error = str(e1)
        try:
            result = ocr.ocr(img_path)
            used_method = "ocr"
        except Exception as e2:
            ocr_error = str(e2)

    if result is None:
        print(json.dumps({
            "ok": False,
            "predict_error": predict_error,
            "ocr_error": ocr_error,
        }, ensure_ascii=False))
        return

    print("USED_METHOD:", used_method, file=sys.stderr)

    out = {"ok": True, "used_method": used_method, "type": str(type(result))}
    try:
        out["len"] = len(result)
    except Exception:
        pass

    try:
        first = result[0]
        out["first_type"] = str(type(first))
        try:
            out["first_keys"] = list(first.keys())
        except Exception:
            pass
        try:
            out["first_repr"] = repr(first)[:4000]
        except Exception as e:
            out["first_repr_error"] = str(e)
    except Exception as e:
        out["first_error"] = str(e)

    print(json.dumps(out, ensure_ascii=False, default=str)[:8000])


if __name__ == "__main__":
    main()
