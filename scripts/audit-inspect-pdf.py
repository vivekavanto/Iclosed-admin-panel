"""Read-only page extraction/render checks. No OCR failure is treated as a blank page."""
import base64, json, pathlib, subprocess, tempfile, sys
import pdfplumber
from PIL import Image
request=json.load(sys.stdin)
raw=base64.b64decode(request['pdf'],validate=True)
if len(raw)>50_000_000 or not raw.startswith(b'%PDF-'):raise ValueError('Invalid signing PDF')
with tempfile.TemporaryDirectory(prefix='audit-inspect-') as tmp:
    root=pathlib.Path(tmp);pdf=root/'source.pdf';pdf.write_bytes(raw)
    with pdfplumber.open(pdf) as document:
        if len(document.pages)>200:raise ValueError('PDF exceeds the 200-page pilot limit')
        pages=[{'number':i+1,'text':(p.extract_text() or '')[:30000],'rendered':False,'inkRatio':None} for i,p in enumerate(document.pages)]
    try:
        subprocess.run(['pdftoppm','-r','36','-gray','-png',str(pdf),str(root/'page')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=75)
        images=sorted(root.glob('page-*.png'))
        if len(images)!=len(pages):raise ValueError('Incomplete rendering')
        for page,image in zip(pages,images):
            with Image.open(image) as im:
                gray=im.convert('L');page['rendered']=True;page['inkRatio']=sum(gray.histogram()[:245])/(gray.width*gray.height)
    except (subprocess.SubprocessError,ValueError,OSError):pass
    print(json.dumps({'pages':pages,'limitations':(['One or more pages could not be rendered; visual completeness cannot be established.'] if any(not p['rendered'] for p in pages) else [])+(['Scanned pages require visual/model review; an empty text extraction is not a blank-page finding.'] if any(len(p['text'].strip())<30 for p in pages) else [])}))
