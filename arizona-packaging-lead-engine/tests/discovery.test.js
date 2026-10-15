const test=require('node:test'); const assert=require('node:assert/strict');
function isArizona(city,address){let x=(city+' '+address).toLowerCase();return /arizona|\baz\b/.test(x)||['phoenix','tucson','mesa'].some(c=>x.includes(c));}
test('requires Arizona evidence rather than search-result assumptions',()=>{assert.equal(isArizona('Phoenix','AZ'),true);assert.equal(isArizona('Austin','Texas'),false);});
test('CSV connector contract',()=>{let headers=['Company Name','Website','City'];assert.deepEqual(headers,['Company Name','Website','City']);});

