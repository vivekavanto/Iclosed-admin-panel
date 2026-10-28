import test from 'node:test';
import assert from 'node:assert/strict';
import {nextWeekStart,torontoDate,closingWindow,inClosingView,nextMonthEnd} from '../../src/lib/orchestrator/closing-views.ts';
const matter=(closingDate:string,status='active')=>({closingDate,status});
test('Current includes today and six following calendar days',()=>{
 assert.deepEqual(closingWindow('five-days','2026-10-23'),{start:'2026-10-23',end:'2026-10-29'});
 for(const day of ['2026-10-23','2026-10-29'])assert.equal(inClosingView(matter(day),'five-days','2026-10-23'),true);
 for(const day of ['2026-10-22','2026-10-30'])assert.equal(inClosingView(matter(day),'five-days','2026-10-23'),false);
 assert.equal(inClosingView(matter('2026-10-24','closed'),'five-days','2026-10-23'),true);
});
test('rolling month handles month ends, leap years and year boundaries',()=>{
 assert.equal(nextMonthEnd('2026-10-23'),'2026-11-23');
 assert.equal(nextMonthEnd('2026-01-31'),'2026-02-28');
 assert.equal(nextMonthEnd('2028-01-31'),'2028-02-29');
 assert.equal(nextMonthEnd('2026-12-31'),'2027-01-31');
 assert.equal(inClosingView(matter('2026-11-23'),'month','2026-10-23'),true);
 assert.equal(inClosingView(matter('2026-11-24'),'month','2026-10-23'),false);
});
test('past files begin Oct 23 and exclude today without asserting completion',()=>{
 assert.equal(inClosingView(matter('2026-10-23'),'past','2026-10-23'),false);
 assert.equal(inClosingView(matter('2026-10-23'),'past','2026-10-24'),true);
 assert.equal(inClosingView(matter('2026-10-23','closed'),'past','2026-10-24'),true);
 assert.equal(inClosingView(matter('2026-10-22'),'past','2026-10-24'),false);
 assert.equal(inClosingView(matter('2026-10-23','inactive'),'past','2026-10-24'),true);
 assert.equal(inClosingView(matter('2026-10-24','inactive'),'five-days','2026-10-24'),false);
 assert.equal(inClosingView(matter('2026-10-23','cancelled'),'past','2026-10-24'),false);
 assert.equal(inClosingView(matter('2026-10-24'),'past','2026-10-24'),false);
});
test('Toronto day changes at local midnight including DST changes',()=>{
 assert.equal(torontoDate(new Date('2026-10-24T03:59:59Z')),'2026-10-23');
 assert.equal(torontoDate(new Date('2026-10-24T04:00:00Z')),'2026-10-24');
 assert.equal(torontoDate(new Date('2026-11-02T04:59:59Z')),'2026-11-01');
 assert.equal(torontoDate(new Date('2026-11-02T05:00:00Z')),'2026-11-02');
});

test('week divider starts on the next Monday, including Sunday and year rollover',()=>{
 assert.equal(nextWeekStart('2026-10-27'),'2026-11-02');
 assert.equal(nextWeekStart('2026-11-01'),'2026-11-02');
 assert.equal(nextWeekStart('2026-11-02'),'2026-11-09');
 assert.equal(nextWeekStart('2026-12-31'),'2027-01-04');
});
