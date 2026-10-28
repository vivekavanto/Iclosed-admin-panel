"""Deterministic, unsigned COO review packets. Reads JSON stdin; writes JSON stdout.
No provider access, signature assets, email, disk output or source-file mutation.
"""
import base64, hashlib, io, json, re, sys
from datetime import date
from html import escape
from pathlib import Path
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph

LABELS={"tax":"Tax Department","water":"Water Department","condo":"Condominium Management"}
def pretty(value):
    return date.fromisoformat(value).strftime('%B %d, %Y').replace(' 0',' ')
def lines(value):
    return '<br/>'.join(escape(x.strip()) for x in value.splitlines() if x.strip())
def sample_transfer(d):
    b=io.BytesIO();c=Canvas(b,pagesize=letter,invariant=1)
    c.setFont('Helvetica-Bold',15);c.drawString(55,735,'FICTIONAL TRANSFER - PREVIEW ONLY')
    c.setFont('Helvetica',11)
    for n,t in enumerate([f"Transfer Receipted as {d['instrument']} on {d['registrationDate'].replace('-',' ')}",d['property'],'New owners: '+d['newOwners'].replace('\n',', '),'Page 1 of 1','This sample is not a registered instrument.']):c.drawString(55,700-n*26,t)
    c.save();return b.getvalue()
def source_reader(d,raw,demo):
    if demo:return PdfReader(io.BytesIO(sample_transfer(d))),None
    if not raw:raise ValueError('Attach the complete registered transfer PDF before generating review copies.')
    try:data=base64.b64decode(raw,validate=True)
    except Exception:raise ValueError('The registered transfer upload is invalid.')
    if len(data)>10_000_000 or not data.startswith(b'%PDF-'):raise ValueError('Choose a registered transfer PDF smaller than 10 MB.')
    try:r=PdfReader(io.BytesIO(data),strict=True)
    except Exception:raise ValueError('The transfer PDF cannot be read. Choose a complete, readable copy.')
    if r.is_encrypted:raise ValueError('Use an unlocked copy of the registered transfer for review.')
    if not 1<=len(r.pages)<=60:raise ValueError('The transfer PDF has an unsupported page count.')
    text=r.pages[0].extract_text() or ''
    match=re.search(r'Transfer\s+Receipted\s+as\s+([A-Z]{1,4}\d+)\s+on\s+(\d{4})\s+(\d{2})\s+(\d{2})',text,re.I)
    if not match:raise ValueError('The attachment must be a searchable registered transfer. Its registration heading could not be verified.')
    actual='-'.join(match.group(i) for i in (2,3,4))
    if match.group(1).upper()!=d['instrument'].upper() or actual!=d['registrationDate']:raise ValueError('The instrument number or registration date does not match the attached transfer.')
    return r,hashlib.sha256(data).hexdigest()
def cover(d,kind,combined=False,delivery_ready=False):
    b=io.BytesIO();c=Canvas(b,pagesize=letter,invariant=1)
    c.drawImage(str(Path(__file__).parent/'assets'/'nw-letterhead.jpg'),52,699,width=508,height=72,preserveAspectRatio=True,mask='auto')
    if not delivery_ready:
        c.setFillColorRGB(.40,.43,.48);c.setFont('Helvetica',8);c.drawString(52,682,'REVIEW COPY - NOT FOR SENDING');c.setFillColorRGB(0,0,0)
    y=659;style=ParagraphStyle('body',fontName='Times-Roman',fontSize=11,leading=14,spaceAfter=0)
    def paragraph(text,after=9,bold=False):
        nonlocal y
        p=Paragraph(('<b>'+text+'</b>')if bold else text,style);_,h=p.wrap(508,720)
        if y-h<53:raise ValueError(f"The {LABELS[kind]} notice exceeds one page. Shorten the legal description or address details.")
        p.drawOn(c,52,y-h);y-=h+after
    r=dict(d['recipients'][kind])
    if combined:
        emails=[s.strip() for k in ('tax','water') for s in re.split('[,;]',d['recipients'][k]['email']) if s.strip()]
        r['email']=', '.join(dict((s.lower(),s) for s in emails).values())
    paragraph(pretty(d['noticeDate'])+'<br/>By email: '+escape(r['email'])+('<br/>CC: '+escape(d['cc']) if d.get('cc') else ''),12)
    paragraph('<br/>'.join(filter(None,[lines(r['organization']),('Attention: '+lines(r['attention']))if r['attention'] else '',lines(r['address'])])),12)
    if kind=='condo' and d.get('condoCorporation'):paragraph('Condominium corporation: '+lines(d['condoCorporation']),8)
    paragraph('Dear Sir/Madam:',8)
    paragraph(('Re: Change of Ownership - Tax and Water' if combined else 'Re: Change of Ownership')+'<br/>'+lines(d['property'])+'<br/>Our File No.: '+escape(d['fileNumber']),9,True)
    if d['legalDescription']:paragraph(lines(d['legalDescription']),8)
    paragraph('Registered transfer: '+escape(d['instrument'])+'<br/>Registration date: '+pretty(d['registrationDate']),8)
    c.setStrokeColorRGB(.7,.72,.75);c.line(52,y+3,560,y+3);y-=9
    if d['transaction']=='sale':
        statement=f"Please be advised that we are the solicitors for {lines(d['clients'])}, who, effective {pretty(d['effectiveDate'])}, sold the property described above to the following new owner(s):"
    else:
        action='acquired ownership of' if d['transaction']=='refinance' else 'purchased'
        statement=f"Please be advised that we are the solicitors for {lines(d['clients'])}, who, effective {pretty(d['effectiveDate'])}, {action} the property described above. Kindly amend your records to show the following new owner(s):"
    paragraph(statement,9)
    paragraph(lines(d['newOwners']),10,True)
    if d['transaction']=='sale':paragraph('Kindly amend your records to reflect this change of ownership.',9)
    request={'tax':'a copy of the current tax bill and all future tax notices and bills','water':'a copy of the current water account statement and all future water notices and bills','condo':'condominium fee statements, notices and future correspondence'}[kind]
    if combined:request='a copy of the current tax and water bills and all future tax and water notices and bills'
    if d['forwardingAddress'].strip():
        paragraph('Please forward '+request+' to the new owner(s) at:',6)
        paragraph(lines(d['forwardingAddress']),10)
    if d['transaction']=='sale' and d.get('purchaserSolicitor','').strip():
        paragraph('If further information is required, please contact the purchaser’s solicitor:',6)
        paragraph(lines(d['purchaserSolicitor']),10)
    paragraph('Thank you for your co-operation in this matter.',10)
    paragraph('Yours very truly,<br/>Nava Wilson Professional Corporation',6)
    paragraph(('' if delivery_ready else '<i>Unsigned review copy</i><br/>')+'Kubeskaran Navaratnam<br/>KN:'+escape(d['initials'].lower())+'<br/>Enclosure: complete registered transfer',0)
    c.save();return b.getvalue()
def render(payload):
    d=payload['draft'];demo=payload.get('demo') is True
    for value in [d.get(k,'') for k in ('property','clients','newOwners','forwardingAddress','legalDescription','purchaserSolicitor','clerk','initials')]+[v for r in d['recipients'].values() for k,v in r.items() if k!='enabled']:
        try:value.encode('cp1252')
        except UnicodeEncodeError:raise ValueError('The notice contains characters requiring an additional font. Please arrange a supported template before generating it.')
    if d.get('firm')!='navawilson':raise ValueError('This firm template has not been configured.')
    reader,source_hash=source_reader(d,payload.get('transferBase64'),demo)
    combined=d.get('combineTaxWater') is True
    if combined:
        a=d['recipients']['tax'];b=d['recipients']['water']
        if not a['enabled'] or not b['enabled'] or any(' '.join(a[k].lower().split())!=' '.join(b[k].lower().split()) for k in ('organization','attention','address')):raise ValueError('A combined tax and water notice requires the same verified recipient for both services.')
    packets=[]
    for kind in LABELS:
        if combined and kind=='water':continue
        if not d['recipients'][kind]['enabled']:continue
        writer=PdfWriter();writer.append(PdfReader(io.BytesIO(cover(d,kind,combined and kind=='tax',payload.get('deliveryReady') is True and not demo))));writer.append(reader)
        output=io.BytesIO();writer.write(output);data=output.getvalue()
        packets.append({'department':kind,'coveredDepartments':['tax','water'] if combined and kind=='tax' else [kind],'filename':f"{d['fileNumber']}-COO-{'tax-water' if combined and kind=='tax' else kind}{'' if payload.get('deliveryReady') and not demo else '-REVIEW'}.pdf",'pdfBase64':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest(),'pages':1+len(reader.pages)})
    return {'packets':packets,'sourceTransferHash':source_hash,'sourcePages':len(reader.pages),'sendingEnabled':False,'signed':False}
if __name__=='__main__':
    try:print(json.dumps(render(json.load(sys.stdin))))
    except (ValueError,KeyError,TypeError) as e:print(json.dumps({'error':str(e)}));sys.exit(2)
