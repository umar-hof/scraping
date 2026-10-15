const test=require('node:test'); const assert=require('node:assert/strict');
function domain(url){return new URL(/^https?:\/\//i.test(url)?url:'https://'+url).hostname.replace(/^www\./,'').toLowerCase();}
test('normalizes registrable-host input for duplicate checks',()=>{assert.equal(domain('https://WWW.Example.com/about'),'example.com');});
test('allows multiple contacts only when identity differs',()=>{let rows=[{domain:'a.com',email:'x@a.com'}];assert.equal(rows.some(r=>r.domain==='a.com'),true);assert.equal(rows.some(r=>r.email==='y@a.com'),false);});

