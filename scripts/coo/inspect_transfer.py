"""Extract explicitly labelled Ontario registered-transfer facts, never tax affidavits.
No provider calls, writes, inferred recipients or DOB retention.
"""
import base64,io,json,re,sys
from datetime import date
from pypdf import PdfReader

def clean(s):return re.sub(r'\s+', ' ', s).strip()
def name(s):
    parts=s.split(',',1)
    return clean(parts[1]+' '+parts[0]) if len(parts)==2 else clean(s)
def parties(section):
    result=[]
    for m in re.finditer(r'^Name\s+(.+?)(?=^Name\s|\Z)',section,re.M|re.S):
        block=m.group(1)
        n=re.split(r'\s+(?:Joint Tenants|Tenants In Common|Registered Owner|Date of Birth|Address for Service)\b',block,flags=re.I)[0]
        address=re.search(r'Address for Service\s+(.+?)(?=\n(?:I am|My spouse|This document|A person|Date of Birth)|\Z)',block,re.S)
        share=re.search(r'(\d+(?:\.\d+)?)\s*%',block)
        result.append({'name':name(n),'address':clean(address.group(1)) if address else '',**({'share':float(share.group(1))} if share else {})})
    return result

def inspect(raw):
    data=base64.b64decode(raw,validate=True)
    if len(data)>10_000_000 or not data.startswith(b'%PDF-'):raise ValueError('Invalid transfer PDF')
    reader=PdfReader(io.BytesIO(data),strict=True)
    if reader.is_encrypted or not 1<=len(reader.pages)<=60:raise ValueError('Unsupported transfer PDF')
    texts=[p.extract_text() or '' for p in reader.pages]
    heading=r'Transfer\s+Receipted\s+as\s+([A-Z]{1,4}\d+)\s+on\s+(\d{4})\s+(\d{2})\s+(\d{2})'
    match=re.search(heading,texts[0],re.I)
    if not match:return None
    if any(m.group(0) and tuple(m.group(i).upper() for i in range(1,5))!=tuple(match.group(i).upper() for i in range(1,5)) for page in texts for m in re.finditer(heading,page,re.I)):raise ValueError('Conflicting registered headings')
    registered='-'.join(match.group(i) for i in (2,3,4));date.fromisoformat(registered)
    # Do not let repeated LRO/page headers interrupt party or solicitor sections.
    text='\n'.join(texts)
    text=re.sub(r'LRO #.*?Page\s+\d+\s+of\s+\d+\s*\n','',text,flags=re.S)
    text=text.split('LAND TRANSFER TAX STATEMENTS')[0]
    def section(a,b):
        m=re.search(a+r'\s*\n(.*?)(?=\n'+b+r'\b|\Z)',text,re.S)
        return m.group(1) if m else ''
    properties=[]
    for p in re.split(r'\nPIN ',section('Properties','Consideration')):
        desc=re.search(r'\bDescription\s+(.+?)\nAddress\s+(.+?)(?=\nPIN|\Z)',p,re.S)
        if desc:properties.append({'description':clean(desc.group(1)),'address':clean(desc.group(2))})
    sellers=parties(section(r'Transferor\(s\)','Transferee'))
    buyers=parties(section(r'Transferee\(s\) Capacity Share','Signed By'))
    signed=section('Signed By','Submitted By').replace('\nSigned By\n','\n')
    solicitors=[]
    for block in re.split(r'\nI am the solicitor.*?\nI have the authority[^\n]*\n?',signed,flags=re.S):
        m=re.search(r'^(.*?)\s+acting for\s+(Transferor|Transferee)\(s\)\s+Signed\s+\d{4}\s+\d{2}\s+\d{2}\s+(.*)',block.strip(),re.S)
        if not m:continue
        contact=clean(m.group(1));tail=m.group(3).split('I am the solicitor')[0]
        email=re.search(r'Email\s+([^\s@]+@[^\s@]+)',tail)
        phone=re.search(r'Tel\s+([^\n]+)',tail)
        solicitors.append({'role':m.group(2).lower(),'contact':contact,'email':email.group(1) if email else '', 'phone':clean(phone.group(1)) if phone else ''})
    submitted=section('Submitted By','Fees/Taxes/Payment')
    submitted_email=re.search(r'Email\s+([^\s@]+@[^\s@]+)',submitted)
    firm=re.match(r'(.+?)\s+(?:\d|[A-Z]\d\s*-)',clean(submitted))
    if firm and submitted_email:
        for solicitor in solicitors:
            if solicitor['email'].lower()==submitted_email.group(1).lower():solicitor['firm']=firm.group(1)
    expected=re.search(r'Page\s+1\s+of\s+(\d+)',texts[0])
    file_numbers={role.lower():clean(value) for role,value in re.findall(r'(Transferor|Transferee) Client File Number\s*:\s*([^\n]+)',text)}
    return {'instrument':match.group(1).upper(),'registrationDate':registered,'pages':len(texts),'complete':bool(expected and int(expected.group(1))==len(texts)), 'properties':properties,'transferors':sellers,'transferees':buyers,'solicitors':solicitors,'fileNumbers':file_numbers}

if __name__=='__main__':
    try:print(json.dumps(inspect(json.load(sys.stdin)['pdf'])))
    except Exception:print('null');sys.exit(2)
