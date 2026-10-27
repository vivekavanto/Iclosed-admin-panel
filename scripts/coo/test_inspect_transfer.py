import base64,io,unittest
from reportlab.pdfgen.canvas import Canvas
from inspect_transfer import inspect
class TransferFacts(unittest.TestCase):
 def pdf(self,text):
  b=io.BytesIO();c=Canvas(b)
  for i,line in enumerate(text.splitlines()):c.drawString(40,800-i*14,line)
  c.save();return base64.b64encode(b.getvalue()).decode()
 def test_registered_heading(self):
  r=inspect(self.pdf('Transfer Receipted as AT1234567 on 2026 10 23'))
  self.assertEqual(r['instrument'],'AT1234567');self.assertEqual(r['registrationDate'],'2026-10-23');self.assertFalse(r['complete'])
 def test_not_registered(self):
  self.assertIsNone(inspect(self.pdf('Transfer in preparation - AT1234567')))
  with self.assertRaises(Exception):inspect('invalid PDF')
 def test_parties_and_role_specific_solicitors_not_tax_affidavit(self):
  text='''Transfer Receipted as AT1234567 on 2026 10 23
Page 1 of 1
Properties
PIN 1234
Description LOT 1, PLAN 2
Address 42 EXAMPLE ROAD
TORONTO
Consideration
Consideration $1
Transferor(s)
Name SMITH, ALEX
Address for Service 1 Old Road, Toronto
I am at least 18 years of age.
Transferee(s) Capacity Share
Name JONES, ROBIN Joint Tenants
Date of Birth 1900 01 01
Address for Service Unit 2, 42 Example Road, Toronto
Name LEE, CASEY Joint Tenants
Date of Birth 1900 01 01
Address for Service Unit 2, 42 Example Road, Toronto
Signed By
Seller Lawyer 1 Old Road
Toronto
M1A 1A1
acting for
Transferor(s)
Signed 2026 10 23
Tel 111-111-1111
Email seller@example.test
I am the solicitor for the transferor(s).
I have the authority to sign and register the document.
Buyer Lawyer 2 New Road
Toronto
M1B 1B1
acting for
Transferee(s)
Signed 2026 10 23
Tel 222-222-2222
Email buyer@example.test
I am the solicitor for the transferee(s).
I have the authority to sign and register the document.
Submitted By
Seller Firm
File Number
Transferor Client File Number : 26S-0001
LAND TRANSFER TAX STATEMENTS
Name FAKE, WRONG'''
  r=inspect(self.pdf(text));self.assertEqual([o['name'] for o in r['transferees']],['ROBIN JONES','CASEY LEE']);self.assertEqual(r['transferees'][0]['address'],'Unit 2, 42 Example Road, Toronto');self.assertNotIn('1900',str(r));self.assertTrue(r['complete']);self.assertEqual(r['solicitors'][1]['email'],'buyer@example.test');self.assertIn('Buyer Lawyer',r['solicitors'][1]['contact']);self.assertEqual(r['fileNumbers']['transferor'],'26S-0001')
if __name__=='__main__':unittest.main()
