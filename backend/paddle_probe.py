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
    # 문서방향분류/휘어짐보정/텍스트줄방향분류(doc_orientation_classify, doc_unwarping,
    # textline_orientation)는 paddleocr 3.x 기본 파이프라인에 새로 추가된 전처리 단계인데,
    # 이 서버 환경(oneDNN)에서 "ConvertPirAttribute2RuntimeAttribute" 에러를 내는 것으로
    # 확인됨 — 우리 문서는 스캔 방향이 항상 바르므로 꺼도 무방하다.
    ocr = PaddleOCR(
        lang="korean",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )

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
