const test=require('node:test'); const assert=require('node:assert/strict');
function email(v){if(!v)return {status:'UNVERIFIED',value:''};v=String(v).trim().toLowerCase();return {status:/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)?'FORMAT_VALID':'INVALID',value:v};}
function phone(v){let d=String(v||'').replace(/\D/g,'');if(d.length===10)d='1'+d;return {status:d.length===11&&d[0]==='1'?'FORMAT_VALID':'INVALID',value:d.length===11&&d[0]==='1'?'+'+d:String(v||'')};}
test('validates email without inventing it',()=>{assert.equal(email(' A@Example.COM ').value,'a@example.com');assert.equal(email('bad').status,'INVALID');});
test('normalizes US phone',()=>{assert.equal(phone('(602) 555-0123').value,'+16025550123');assert.equal(phone('123').status,'INVALID');});

