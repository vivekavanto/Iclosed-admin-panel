#!/usr/bin/env python3
"""Offline OCR adapter for Linux workers; same interface as the macOS helper."""
import csv,io,json,os,pathlib,subprocess,sys

def read_tsv(tsv):
    lines={};scores=[]
    for row in csv.DictReader(io.StringIO(tsv),delimiter='\t'):
        if row.get('level')!='5':continue
        text=(row.get('text') or '').strip()
        if not text:continue
        score=float(row['conf'])
        if score<0:continue
        key=tuple(row[k] for k in ['page_num','block_num','par_num','line_num'])
        lines.setdefault(key,[]).append(text);scores.append(max(0,min(100,score))/100)
    return '\n'.join(' '.join(words) for words in lines.values()),sum(scores)/len(scores) if scores else 0

def main():
    request=json.load(sys.stdin);pages=request['pages'];images=request.get('images',{})
    if not isinstance(pages,list) or len(pages)>1000:raise ValueError('Invalid page request')
    output=[]
    for number in pages:
        if not isinstance(number,int) or number<1:raise ValueError('Invalid page number')
        image=pathlib.Path(images[str(number)])
        if not image.is_absolute() or not image.is_file():raise ValueError('A rendered page image is required')
        result=subprocess.run(['tesseract',str(image),'stdout','-l','eng','--psm','3','tsv'],capture_output=True,text=True,check=True,timeout=90,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
        text,confidence=read_tsv(result.stdout)
        output.append({'number':number,'text':text,'confidence':confidence})
    json.dump(output,sys.stdout)
if __name__=='__main__':
    try:main()
    except Exception:
        # Never include document contents, filenames or provider output in logs.
        sys.stderr.write('Cloud OCR could not process a requested page.\n');sys.exit(2)
