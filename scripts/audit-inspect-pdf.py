"""Read-only page extraction/render checks. No OCR failure is treated as a blank page."""
import base64, json, pathlib, subprocess, tempfile, sys, os
import pdfplumber
import pypdfium2 as pdfium
from PIL import Image
from audit_text_quality import needs_ocr
request=json.load(sys.stdin)
raw=base64.b64decode(request['pdf'],validate=True)
if len(raw)>50_000_000 or not raw.startswith(b'%PDF-'):raise ValueError('Invalid signing PDF')
with tempfile.TemporaryDirectory(prefix='audit-inspect-') as tmp:
    root=pathlib.Path(tmp);pdf=root/'source.pdf';pdf.write_bytes(raw)
    with pdfium.PdfDocument(str(pdf)) as native:
        count=len(native)
    if count<1 or count>200:raise ValueError('PDF page inventory must contain 1 to 200 pages')
    pages=[{'number':i+1,'text':'','rendered':False,'inkRatio':None,'textNeedsReview':True} for i in range(count)]
    try:
        with pdfplumber.open(pdf) as document:
            for i,p in enumerate(document.pages[:count]):
                try:
                    text=(p.extract_text() or '')[:30000]
                    image_area=sum(float(im.get('width',0))*float(im.get('height',0)) for im in p.images)
                    pages[i].update(text=text,textNeedsReview=needs_ocr(text,image_area>p.width*p.height*.2))
                except Exception:
                    # Keep the native page available for OCR and visual review.
                    continue
    except Exception:
        # Some valid PDFs have page trees the text parser cannot enumerate.
        # Native page count plus per-page rendering/OCR remain authoritative.
        pass
    ocr=os.environ.get('ORCHESTRATOR_AUDIT_OCR')
    ocr_failed=False
    if ocr and pathlib.Path(ocr).is_absolute():
        needed=[p['number'] for p in pages if p['textNeedsReview']]
        if needed:
            try:
                # PDFKit can drop glyphs from embedded fonts while PDFium renders
                # the same page correctly. OCR the exact native rendering we verify.
                images={}
                with pdfium.PdfDocument(str(pdf)) as native:
                    for number in needed:
                        page=native[number-1]
                        try:
                            bitmap=page.render(scale=2)
                            try:
                                image_path=root/f'ocr-{number}.png'
                                bitmap.to_pil().save(image_path)
                                images[str(number)]=str(image_path)
                            finally:bitmap.close()
                        finally:page.close()
                result=subprocess.run([ocr],input=json.dumps({'pdf':str(pdf),'pages':needed,'images':images}),text=True,capture_output=True,check=True,timeout=min(600,max(160,12*len(needed))))
                for item in json.loads(result.stdout):
                    page=pages[item['number']-1]
                    if item['number'] not in needed or not isinstance(item['text'],str):raise ValueError('Invalid OCR response')
                    page.update(text=item['text'][:30000],textMethod='ocr',ocrConfidence=item['confidence'],textNeedsReview=needs_ocr(item['text']))
            except (subprocess.SubprocessError,ValueError,OSError,KeyError,TypeError):ocr_failed=True
    # Render in process with pdfplumber's installed PDFium dependency. Login-service
    # PATH must not determine whether every matter page can be checked visually.
    with pdfium.PdfDocument(str(pdf)) as document:
        if len(document)!=len(pages):raise ValueError('Incomplete page inventory')
        for index,page in enumerate(pages):
            try:
                native_page=document[index]
                try:
                    bitmap=native_page.render(scale=.5,grayscale=True)
                    try:
                        gray=bitmap.to_pil().convert('L')
                        page.update(rendered=True,inkRatio=sum(gray.histogram()[:245])/(gray.width*gray.height))
                    finally:bitmap.close()
                finally:native_page.close()
            except Exception:
                # Keep the precise failed page visible; other pages are still usable.
                continue
    print(json.dumps({'pages':pages,'limitations':(['Local OCR failed for one or more scanned pages.'] if ocr_failed else [])+(['One or more pages could not be rendered; visual completeness cannot be established.'] if any(not p['rendered'] for p in pages) else [])+(['One or more pages have missing or corrupted extracted text and require visual review; this is not a blank-page finding.'] if any(p['textNeedsReview'] for p in pages) else [])}))
