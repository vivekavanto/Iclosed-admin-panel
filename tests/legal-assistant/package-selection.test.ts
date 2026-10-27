import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPackagePdf} from '../../src/lib/orchestrator/package-selection.ts';
const address='306-8 Harbour Street, Toronto, ON, M1A 1A1';
const pdf=(id:string,name:string)=>({id,name});
test('signing package takes precedence over an address-named PDF',()=>{
 const sources=[pdf('address','306-8 Harbour St.pdf'),pdf('package','Signing package.pdf')];
 assert.equal(defaultPackagePdf(sources,address)?.id,'package');
 assert.equal(defaultPackagePdf([pdf('p','SIGNING-PACKAGE - 306-8 Harbour.pdf')],address)?.id,'p');
});
test('address defaults preserve building and unit identity, with suffix/city variants',()=>{
 for(const name of ['306-8 Harbour Street.pdf','306-8 Harbour St, Toronto.pdf','306-8 Harbour.pdf'])assert.equal(defaultPackagePdf([pdf('a',name)],address)?.id,'a');
 for(const name of ['307-8 Harbour St.pdf','306-9 Harbour St.pdf','306-8 Harbour Avenue.pdf','APS - 306-8 Harbour St.pdf'])assert.equal(defaultPackagePdf([pdf('a',name)],address),null);
});
test('multiple matches or review documents require a manual choice',()=>{
 assert.equal(defaultPackagePdf([pdf('p','Signing Package.pdf'),pdf('p2','Signing Package revised.pdf'),pdf('a','306-8 Harbour St.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('a','306-8 Harbour St.pdf'),pdf('b','306-8 Harbour Street.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('a','Signing Package QA Report.pdf'),pdf('b','Signing Package Instructions.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('a','Signing Package.docx')],address),null);
});

test('unique address-only street spelling variant keeps numeric identity exact',()=>{
 const address='27 Holloway Road, Markham, ON, L3S4P2';
 assert.equal(defaultPackagePdf([pdf('p','27 Halloway Road.pdf')],address)?.id,'p');
 assert.equal(defaultPackagePdf([pdf('p','28 Halloway Road.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('p','27 Halloway Avenue.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('p','APS 27 Halloway Road.pdf')],address),null);
 assert.equal(defaultPackagePdf([pdf('p','27 Halloway Road.pdf'),pdf('q','27 HolloWay Rd.pdf')],address)?.id,'q');
 assert.equal(defaultPackagePdf([pdf('p','27 Halloway Road.pdf'),pdf('q','27 Hollaway Road.pdf')],address),null);
});
