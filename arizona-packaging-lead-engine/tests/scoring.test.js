const test=require('node:test'); const assert=require('node:assert/strict');
const scores={'Cosmetics & Skincare Brands':92,'Candles & Home Fragrance':88,'Bakeries & Restaurants':55};
function score(d){let s=(scores[d.industry]||0)*.35;if(/2-50|1-10|11-50/.test(d.employeeSize||''))s+=20;else if(/51-200/.test(d.employeeSize||''))s+=12;if(/arizona|phoenix|tucson/i.test((d.city||'')+' '+(d.address||'')))s+=15;if(d.brandEvidence)s+=15;if(d.packagingOpportunity)s+=10;if(d.pocName)s+=5;return Math.round(Math.min(100,s));}
test('prioritizes high-fit Arizona product brands',()=>{assert.ok(score({industry:'Cosmetics & Skincare Brands',employeeSize:'2-50',city:'Phoenix',brandEvidence:'official',packagingOpportunity:'launch',pocName:'A'})>=90);});
test('does not treat unknown data as positive',()=>{assert.ok(score({industry:'Bakeries & Restaurants'})<60);});

