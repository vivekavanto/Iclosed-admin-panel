"""Detect missing PDF text and broken font mappings without treating either as blank."""
import re

def needs_ocr(text,has_page_image=False):
    stripped=text.strip()
    if len(stripped)<30 or (has_page_image and len(stripped)<500):
        return True
    mapped=re.findall(r'\(cid:\d+\)',stripped)
    return sum(len(item) for item in mapped)>len(stripped)*0.1 or stripped.count('\ufffd')>max(3,len(stripped)*0.01)
