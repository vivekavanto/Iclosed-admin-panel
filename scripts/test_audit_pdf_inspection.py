"""Run with the configured audit Python; no network, credentials, or client fixtures."""
import base64, io, json, os, pathlib, subprocess, sys, unittest, runpy
from contextlib import redirect_stdout
from unittest.mock import patch, MagicMock
from reportlab.pdfgen import canvas

class PdfInspectionTests(unittest.TestCase):
    def test_native_renderer_works_without_poppler_path_and_keeps_blank_page(self):
        output=io.BytesIO();pdf=canvas.Canvas(output)
        pdf.drawString(72,720,'Synthetic signing package: a readable first page.');pdf.showPage()
        pdf.showPage();pdf.save()
        result=subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('audit-inspect-pdf.py'))],input=json.dumps({'pdf':base64.b64encode(output.getvalue()).decode()}),capture_output=True,text=True,check=True,env={**os.environ,'PATH':'/unavailable','ORCHESTRATOR_AUDIT_OCR':''},timeout=30)
        data=json.loads(result.stdout)
        self.assertEqual(len(data['pages']),2)
        self.assertTrue(all(page['rendered'] for page in data['pages']))
        self.assertGreater(data['pages'][0]['inkRatio'],0)
        self.assertEqual(data['pages'][1]['inkRatio'],0)
        self.assertIn('readable first page',data['pages'][0]['text'])
        self.assertFalse(any('could not be rendered' in line for line in data['limitations']))

    def test_text_reader_zero_pages_does_not_discard_visually_readable_pdf(self):
        output=io.BytesIO();pdf=canvas.Canvas(output)
        pdf.drawString(72,720,'Synthetic tax source');pdf.showPage();pdf.save()
        request=io.StringIO(json.dumps({'pdf':base64.b64encode(output.getvalue()).decode()}));response=io.StringIO()
        document=MagicMock();document.__enter__.return_value.pages=[]
        with patch('pdfplumber.open',return_value=document),patch.object(sys,'stdin',request),patch.dict(os.environ,{'ORCHESTRATOR_AUDIT_OCR':''}),redirect_stdout(response):
            runpy.run_path(str(pathlib.Path(__file__).with_name('audit-inspect-pdf.py')))
        pages=json.loads(response.getvalue())['pages']
        self.assertEqual(len(pages),1)
        self.assertTrue(pages[0]['rendered'])
        self.assertTrue(pages[0]['textNeedsReview'])

    def test_ocr_receives_pdfium_images_instead_of_pdfkit_font_rendering(self):
        from types import SimpleNamespace
        output=io.BytesIO();pdf=canvas.Canvas(output)
        pdf.drawString(72,720,'Synthetic management contact');pdf.showPage();pdf.save()
        request=io.StringIO(json.dumps({'pdf':base64.b64encode(output.getvalue()).decode()}));response=io.StringIO()
        document=MagicMock();document.__enter__.return_value.pages=[]
        def recognize(*args,**kwargs):
            supplied=json.loads(kwargs['input'])
            self.assertEqual(supplied['pages'],[1])
            image=pathlib.Path(supplied['images']['1'])
            self.assertTrue(image.read_bytes().startswith(b'\x89PNG'))
            return SimpleNamespace(stdout=json.dumps([{'number':1,'text':'Property management contact is manager@example.test','confidence':0.99}]))
        with patch('pdfplumber.open',return_value=document),patch('subprocess.run',side_effect=recognize),patch.object(sys,'stdin',request),patch.dict(os.environ,{'ORCHESTRATOR_AUDIT_OCR':'/synthetic/ocr'}),redirect_stdout(response):
            runpy.run_path(str(pathlib.Path(__file__).with_name('audit-inspect-pdf.py')))
        page=json.loads(response.getvalue())['pages'][0]
        self.assertIn('manager@example.test',page['text']);self.assertTrue(page['rendered']);self.assertEqual(page['textMethod'],'ocr')

if __name__=='__main__':unittest.main()
