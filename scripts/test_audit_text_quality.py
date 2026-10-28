import unittest
from audit_text_quality import needs_ocr

class TextQuality(unittest.TestCase):
    def test_broken_fonts_and_missing_text_need_ocr(self):
        self.assertTrue(needs_ocr(''))
        self.assertTrue(needs_ocr('(cid:11)(cid:16)(cid:7)(cid:16)(cid:14)(cid:29)'))
        self.assertTrue(needs_ocr('\ufffd'*20+' unreadable text mapping'))
    def test_readable_text_and_incidental_font_code_are_retained(self):
        self.assertFalse(needs_ocr('Mortgage payment date is November 12, 2026. Payout is $100,000.00.'))
        self.assertFalse(needs_ocr('Readable source paragraph with a literal (cid:1) example and sufficient normal content. '*3))
    def test_scanned_body_with_readable_signature_service_header_needs_ocr(self):
        header='Docusign Envelope ID: 1AEE7BAA-2362-84C9-8245-5DC1BE9D777F'
        self.assertFalse(needs_ocr(header))
        self.assertTrue(needs_ocr(header,True))

if __name__=='__main__':unittest.main()
