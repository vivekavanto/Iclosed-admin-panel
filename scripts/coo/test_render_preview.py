import base64, copy, io, json, unittest
from pathlib import Path
from pypdf import PdfReader
from render_preview import render
ROOT=Path(__file__).resolve().parents[2]
def draft():return json.loads((ROOT/'tests/fixtures/coo-demo.json').read_text())
class ReviewPackets(unittest.TestCase):
 def test_all_notices_keep_attachment_and_condo_wording(self):
  result=render({'draft':draft(),'demo':True})
  self.assertFalse(result['sendingEnabled']);self.assertFalse(result['signed']);self.assertEqual(len(result['packets']),3)
  for p in result['packets']:
   pdf=PdfReader(io.BytesIO(base64.b64decode(p['pdfBase64'])))
   self.assertEqual(len(pdf.pages),2);self.assertIn('REVIEW COPY',pdf.pages[0].extract_text());self.assertIn('FICTIONAL TRANSFER',pdf.pages[1].extract_text())
   if p['department']=='condo':
    self.assertIn('condominium fee statements',pdf.pages[0].extract_text());self.assertNotIn('current tax bill',pdf.pages[0].extract_text())
 def test_same_details_produce_same_packet_hash(self):
  one=render({'draft':draft(),'demo':True});two=render({'draft':draft(),'demo':True});self.assertEqual([p['sha256']for p in one['packets']],[p['sha256']for p in two['packets']])
 def test_sale_does_not_describe_purchasers_as_our_clients(self):
  d=draft();d['transaction']='sale';d['fileNumber']='26S-0902';d['newOwners']='Casey Lee'
  p=render({'draft':d,'demo':True})['packets'][0];text=PdfReader(io.BytesIO(base64.b64decode(p['pdfBase64']))).pages[0].extract_text();self.assertIn('sold the property',text);self.assertIn('Casey Lee',text)
 def test_sale_preserves_purchaser_counsel_without_empty_forwarding_request(self):
  d=draft();d['transaction']='sale';d['fileNumber']='26S-0902';d['forwardingAddress']='';d['purchaserSolicitor']='Example Lawyer, Example Firm\nexample@example.com'
  p=render({'draft':d,'demo':True})['packets'][0];text=PdfReader(io.BytesIO(base64.b64decode(p['pdfBase64']))).pages[0].extract_text();self.assertIn('Example Lawyer, Example Firm',text);self.assertIn('example@example.com',text);self.assertNotIn('Please forward',text)
 def test_combined_tax_water_is_one_packet_with_both_scopes(self):
  d=draft();d['combineTaxWater']=True;d['recipients']['water']=copy.deepcopy(d['recipients']['tax']);d['recipients']['condo']['enabled']=False
  result=render({'draft':d,'demo':True});self.assertEqual(len(result['packets']),1);p=result['packets'][0];self.assertEqual(p['coveredDepartments'],['tax','water']);text=PdfReader(io.BytesIO(base64.b64decode(p['pdfBase64']))).pages[0].extract_text();self.assertIn('Tax and Water',text);self.assertIn('current tax and water bills',text)
 def test_combined_letter_includes_both_service_addresses_and_cc(self):
  d=draft();d['combineTaxWater']=True;d['recipients']['water']=copy.deepcopy(d['recipients']['tax']);d['recipients']['water']['email']='water@example.com';d['recipients']['condo']['enabled']=False;d['cc']='assigned@example.com'
  result=render({'draft':d,'demo':True});self.assertEqual(len(result['packets']),1);p=result['packets'][0];text=PdfReader(io.BytesIO(base64.b64decode(p['pdfBase64']))).pages[0].extract_text();self.assertIn('tax@example.com, water@example.com',text);self.assertIn('CC: assigned@example.com',text);self.assertEqual(p['pages'],2)
 def test_same_email_different_department_cannot_be_combined(self):
  d=draft();d['combineTaxWater']=True;d['recipients']['water']['email']=d['recipients']['tax']['email']
  with self.assertRaisesRegex(ValueError,'same verified recipient'):render({'draft':d,'demo':True})
 def test_mismatched_registered_instrument_is_blocked(self):
  d=draft();source=render({'draft':d,'demo':True})['packets'][0];pdf=PdfReader(io.BytesIO(base64.b64decode(source['pdfBase64'])))
  from pypdf import PdfWriter
  writer=PdfWriter();writer.add_page(pdf.pages[1]);b=io.BytesIO();writer.write(b)
  d['instrument']='AT999999'
  with self.assertRaisesRegex(ValueError,'does not match'):render({'draft':d,'transferBase64':base64.b64encode(b.getvalue()).decode(),'demo':False})
 def test_overflow_is_reported_instead_of_clipping(self):
  d=draft();d['legalDescription']='Very long legal description. '*300
  with self.assertRaisesRegex(ValueError,'exceeds one page'):render({'draft':d,'demo':True})
if __name__=='__main__':unittest.main()
