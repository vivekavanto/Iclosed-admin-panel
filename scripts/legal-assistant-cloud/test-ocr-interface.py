"""Synthetic-only adapter tests; live Tesseract/native preflight remains mandatory."""
import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('ocr',pathlib.Path(__file__).parents[1]/'audit-ocr-tesseract.py');ocr=importlib.util.module_from_spec(spec);spec.loader.exec_module(ocr)
class OCR(unittest.TestCase):
 def test_line_order_and_confidence(self):
  header='level\tpage_num\tblock_num\tpar_num\tline_num\tconf\ttext\n'
  text,confidence=ocr.read_tsv(header+'5\t1\t1\t1\t1\t90\tRegistered\n5\t1\t1\t1\t1\t80\ttransfer\n5\t1\t1\t1\t2\t100\t123456\n')
  self.assertEqual(text,'Registered transfer\n123456');self.assertAlmostEqual(confidence,.9)
 def test_empty_text_is_not_invented(self):
  self.assertEqual(ocr.read_tsv('level\tpage_num\tblock_num\tpar_num\tline_num\tconf\ttext\n5\t1\t1\t1\t1\t-1\t\n'),('',0))
if __name__=='__main__':unittest.main()
