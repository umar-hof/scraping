const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(rows){
  const root=path.join(__dirname,'..','apps-script'),logs=[];
  // Deliberately omit the URL Web API: it is unavailable in Apps Script V8.
  const c={Date,JSON,Math,String,Number,Object,Array,RegExp,Error,Logger:{log:x=>logs.push(String(x))},PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})}};
  vm.createContext(c);
  ['Config.gs','Validation.gs','VerificationEngine.gs','DataQualityWorkflow.gs'].forEach(f=>vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c,{filename:f}));
  const data=[Array.from(c.PE.PROSPECTS_FULL_HEADERS),...rows];
  const sheet={data,getLastRow(){return data.length;},getLastColumn(){return 42;},getRange(r,col,nr=1,nc=1){return {getValues:()=>data.slice(r-1,r-1+nr).map(row=>Array.from({length:nc},(_,i)=>row[col-1+i]??'')),getDisplayValues:()=>data.slice(r-1,r-1+nr).map(row=>Array.from({length:nc},(_,i)=>String(row[col-1+i]??''))),getValue:()=>data[r-1]?.[col-1]??'',setValue(v){data[r-1][col-1]=v;}};}};
  c.getSpreadsheet_=()=>({getSheetByName:n=>n==='Prospects'?sheet:null});
  c.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};
  return {c,sheet,logs};
}
function row(name,id,website,notes=''){
  const r=Array(42).fill('');r[0]=name;r[9]=website;r[18]='https://brand.example/contact | https://brand.example/about';r[24]=id;r[25]=notes;r[19]='UNVERIFIED';r[20]='UNVERIFIED';return r;
}

test('domain extraction normalizes official website hosts and rejects malformed URLs',()=>{
  const f=harness([]);
  assert.equal(f.c.extractValidatedCompanyDomain_('https://www.Example.co/products?x=1'),'example.co');
  assert.equal(f.c.extractValidatedCompanyDomain_('https://shop.example.co:8443/path'),'shop.example.co');
  assert.equal(f.c.extractValidatedCompanyDomain_('example.co/path'),'example.co');
  assert.equal(f.c.extractValidatedCompanyDomain_('javascript:alert(1)'),'');
  assert.equal(f.c.extractValidatedCompanyDomain_('https://bad host.example/path'),'');
  assert.equal(f.c.extractValidatedCompanyDomain_('https://user:pass@example.co'),'');
});

test('read-only data-quality preview proposes sourced blank-only changes by Lead ID',()=>{
  const r1=row('Example Co','lead-a','https://www.example.co/shop','Public company email (SOURCE_LISTED; not independently verified): team@example.co — https://example.co/contact');
  r1[3]='(602) 555-0100';r1[2]='(480) 555-0101';r1[4]='owner@example.co';
  const f=harness([r1,row('Unknown City','lead-b','https://unknown.example','')]);
  const before=JSON.stringify(f.sheet.data),p=f.c.previewDataQualityImprovements();
  assert.equal(p.dryRun,true);assert.equal(p.summary.totalRecords,2);assert.equal(p.summary.cityReviewedUnknown,2);
  assert.equal(p.records[0].leadId,'lead-a');
  const by=Object.fromEntries(p.records[0].changes.map(x=>[x.header,x]));
  assert.equal(by['Company Domain'].newValue,'example.co');
  assert.equal(by['Company Email'].newValue,'team@example.co');
  assert.equal(by['Company Email Source URL'].newValue,'https://example.co/contact');
  assert.equal(by['POC Email Source URL'].newValue,'https://brand.example/contact');
  assert.equal(by['Company Phone Source URL'].newValue,'https://brand.example/contact');
  assert.equal(by['POC Phone Source URL'].newValue,'https://brand.example/contact');
  assert.equal(by['Email Deliverability Status'].newValue,'UNVERIFIED');
  assert.equal(by['Phone Activity Status'].newValue,'UNVERIFIED');
  assert.equal(p.records[1].changes.some(x=>x.header==='Arizona City'),false);
  assert.equal(JSON.stringify(f.sheet.data),before);
  assert.equal(p.summary.mxLookupPerformed,false);
});

test('updater preserves populated cells, never writes blank values, and is idempotent',()=>{
  const r=row('Example Co','lead-a','https://www.example.co','Public company email (SOURCE_LISTED): info@example.co — https://example.co/contact');
  r[10]='keep.example.co';r[26]='kept@example.co';r[27]='https://old.example/source';r[31]='UNVERIFIED';r[36]='UNVERIFIED';
  const f=harness([r]);
  const first=f.c.applyDataQualityImprovements();
  assert.equal(first.summary.matched,1);assert.ok(first.summary.fieldsUpdated>0);
  assert.equal(f.sheet.data[1][10],'keep.example.co');assert.equal(f.sheet.data[1][26],'kept@example.co');assert.equal(f.sheet.data[1][27],'https://old.example/source');
  assert.equal(f.sheet.data[1][31],'UNVERIFIED');assert.equal(f.sheet.data[1][36],'UNVERIFIED');
  const second=f.c.applyDataQualityImprovements();assert.equal(second.summary.fieldsUpdated,0);assert.equal(second.summary.updatedRows,0);
});

test('domain enters preview and blank-only update, then stays unchanged on rerun',()=>{
  const r=row('Domain Co','lead-domain','https://www.domain.example/products');
  const f=harness([r]);
  const plan=f.c.previewDataQualityImprovements();
  const domain=plan.records[0].changes.find(change=>change.header==='Company Domain');
  assert.equal(domain.newValue,'domain.example');
  assert.equal(domain.sourceUrl,'https://www.domain.example/products');
  assert.equal(f.sheet.data[1][10],'');
  const first=f.c.applyDataQualityImprovements();
  assert.equal(f.sheet.data[1][10],'domain.example');
  assert.equal(first.summary.fieldsUpdated>0,true);
  const second=f.c.applyDataQualityImprovements();
  assert.equal(second.summary.fieldsUpdated,0);
  assert.equal(f.sheet.data[1][10],'domain.example');
});

test('optional MX checking is opt-in and MX_PRESENT never changes deliverability',()=>{
  const r=row('Example Co','lead-a','https://example.co','Public company email (SOURCE_LISTED): hello@example.co — https://example.co/contact');
  const f=harness([r]);let calls=0;
  f.c.UrlFetchApp={fetch:()=>{calls++;return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({Status:0,Answer:[{type:15,data:'mx.example.co'}]})};}};
  const normal=f.c.previewDataQualityImprovements();assert.equal(calls,0);
  const checked=f.c.previewDataQualityImprovements({lookupMx:true});assert.equal(calls,1);
  const mxChange=checked.records[0].changes.find(c=>c.header==='Email Domain MX Status');
  const deliverability=checked.records[0].changes.find(c=>c.header==='Email Deliverability Status');
  assert.equal(mxChange.newValue,'MX_PRESENT');assert.equal(deliverability.newValue,'UNVERIFIED');
  assert.equal(normal.summary.mxLookupPerformed,false);assert.equal(checked.summary.mxLookupPerformed,true);
});

test('data-quality planning rejects duplicate Lead IDs and any non-42-column schema',()=>{
  const a=row('A','duplicate','https://a.example'),b=row('B','duplicate','https://b.example');
  assert.throws(()=>harness([a,b]).c.previewDataQualityImprovements(),/Duplicate Lead IDs/);
  const f=harness([row('A','a','https://a.example')]);f.sheet.getLastColumn=()=>41;
  assert.throws(()=>f.c.previewDataQualityImprovements(),/exactly 42/);
});
