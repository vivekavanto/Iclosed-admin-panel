"""Synthetic-only adapter tests; live Tesseract/native preflight remains mandatory."""
import importlib.util,pathlib,unittest,io,json,tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ocr',pathlib.Path(__file__).parents[1]/'audit-ocr-tesseract.py');ocr=importlib.util.module_from_spec(spec);spec.loader.exec_module(ocr)
class OCR(unittest.TestCase):
 def test_line_order_and_confidence(self):
  header='level\tpage_num\tblock_num\tpar_num\tline_num\tconf\ttext\n'
  text,confidence=ocr.read_tsv(header+'5\t1\t1\t1\t1\t90\tRegistered\n5\t1\t1\t1\t1\t80\ttransfer\n5\t1\t1\t1\t2\t100\t123456\n')
  self.assertEqual(text,'Registered transfer\n123456');self.assertAlmostEqual(confidence,.9)
 def test_empty_text_is_not_invented(self):
  self.assertEqual(ocr.read_tsv('level\tpage_num\tblock_num\tpar_num\tline_num\tconf\ttext\n5\t1\t1\t1\t1\t-1\t\n'),('',0))
 def test_single_cpu_budget_and_page_identity(self):
  with tempfile.TemporaryDirectory() as tmp:
   image=pathlib.Path(tmp)/'page.png';image.write_bytes(b'synthetic image')
   request={'pages':[7],'images':{'7':str(image)}}
   with patch.object(ocr.sys,'stdin',io.StringIO(json.dumps(request))),patch.object(ocr.sys,'stdout',io.StringIO()) as output,patch.object(ocr.subprocess,'run') as run:
    run.return_value.stdout='level\tpage_num\tblock_num\tpar_num\tline_num\tconf\ttext\n5\t1\t1\t1\t1\t95\tTransfer\n'
    ocr.main();self.assertEqual(run.call_args.kwargs['env']['OMP_THREAD_LIMIT'],'1');self.assertEqual(json.loads(output.getvalue())[0]['number'],7)
if __name__=='__main__':unittest.main()
