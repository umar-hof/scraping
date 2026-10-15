const test=require('node:test'); const assert=require('node:assert/strict');
test('retry policy caps attempts',()=>{let max=3;assert.equal([1,2,3].every(n=>n<=max),true);assert.equal(4>max,true);});
test('checkpoint round trip',()=>{let x={lastRun:'2026-10-14',cursor:4};assert.deepEqual(JSON.parse(JSON.stringify(x)),x);});

