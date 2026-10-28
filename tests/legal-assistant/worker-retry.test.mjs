import test from 'node:test';import assert from 'node:assert/strict';
import {workerCycle} from '../../scripts/legal-assistant-hosted/retry.mjs';
test('storage outages back off without restarting or immediately replaying a claimed provider job',async()=>{let calls=0,failures=0;const delays=[];await assert.rejects(workerCycle(async()=>{calls++;if(calls<4)throw Error('storage');return 3000;},{onFailure:()=>failures++,sleep:async ms=>{delays.push(ms);if(calls===4)throw Error('stop');}}),/stop/);assert.equal(failures,3);assert.deepEqual(delays,[2000,4000,8000,3000]);});
test('one-shot verification reports failure without claiming success',async()=>{await assert.rejects(workerCycle(async()=>{throw Error('outage');},{once:true}),/unavailable/);});
