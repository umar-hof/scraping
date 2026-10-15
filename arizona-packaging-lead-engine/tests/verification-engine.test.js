const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function setup(rows){
  const root=path.join(__dirname,'..','apps-script');
  const logs=[];const c={URL,Date,JSON,Math,String,Number,Object,Array,RegExp,Error,Logger:{log:x=>logs.push(String(x))},PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})}};
  vm.createContext(c);['Config.gs','Validation.gs','VerificationEngine.gs'].forEach(f=>vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c,{filename:f}));
  const data=[c.PE.PROSPECTS_FULL_HEADERS.slice(),...rows];
  const sheet={data,getLastRow(){return data.length;},getLastColumn(){return c.PE.PROSPECTS_FULL_HEADERS.length;},getRange(r,col,nr=1,nc=1){return {getValues:()=>data.slice(r-1,r-1+nr).map(row=>Array.from({length:nc},(_,i)=>row[col-1+i]??'')),getDisplayValues:()=>data.slice(r-1,r-1+nr).map(row=>Array.from({length:nc},(_,i)=>String(row[col-1+i]??''))),setValues(){throw new Error('Preview attempted a write');},setValue(){throw new Error('Preview attempted a write');}};}};
  c.getSpreadsheet_=()=>({getSheetByName:n=>n==='Prospects'?sheet:null});return {c,sheet,logs};
}
function prospect(name,email,companyPhone,pocPhone,extraNotes){
  const row=Array(42).fill('');row[0]=name;row[2]=pocPhone||'';row[3]=companyPhone||'';row[4]=email||'';row[6]='UNKNOWN';row[8]=email==='bob@example.com'?'Bob Example':'';row[18]='https://example.com/contact | https://example.com/about';row[19]='UNVERIFIED';row[20]='UNVERIFIED';row[24]='lead-'+name;row[25]=extraNotes||'';return row;
}

test('read-only verification preview audits channels, missing fields, scores, and verification separately',()=>{
  const row1=prospect('Example Co','bob@example.com','(602) 555-0123','+1 480 555 0199','Public company email (SOURCE_LISTED; mailbox activity not independently verified): info@example.com — https://example.com/contact');
  row1[26]='';
  const row2=prospect('No Contact','info@no-contact.example','','','');
  const f=setup([row1,row2]);let writes=0;
  const result=f.c.previewContactVerification();
  assert.equal(result.dryRun,true);assert.equal(result.summary.totalCompanies,2);assert.equal(result.summary.namedPocs,1);
  assert.equal(result.summary.companyEmails,1);assert.equal(result.summary.pocEmails,1);assert.equal(result.summary.companyPhones,1);assert.equal(result.summary.directPocPhones,1);
  assert.equal(result.summary.linkedInProfiles,0);assert.equal(result.companies[0].companyEmail,'info@example.com');
  assert.equal(result.summary.missingCompanyDomains,2);assert.equal(result.summary.companyWebsites,0);
  assert.equal(result.companies[0].pocPhone,'+14805550199');assert.equal(result.companies[0].emailSyntaxStatus,'VALID_FORMAT');
  assert.equal(result.companies[0].phoneFormatStatus,'VALID_FORMAT');assert.equal(result.companies[0].emailDeliverabilityStatus,'UNVERIFIED');
  assert.equal(result.companies[0].phoneActivityStatus,'UNVERIFIED');assert.equal(result.companies[1].pocEmail,'');
  assert.equal(result.companies[1].genericEmailInPocField,true);assert.equal(result.summary.genericPocEmailFlags,1);
  assert.ok(result.companies[0].completenessScore>result.companies[1].completenessScore);
  assert.ok(result.companies[1].missingFields.includes('employeeSize'));assert.equal(writes,0);
  assert.ok(f.logs[0].startsWith('CONTACT_VERIFICATION_PREVIEW '));assert.equal(f.logs[0].includes('bob@example.com'),false);
});

test('optional MX check distinguishes MX presence from deliverability and caches each domain',()=>{
  const row=prospect('Example Co','bob@example.com','','','');let calls=0;
  const f=setup([row]);f.c.UrlFetchApp={fetch:url=>{calls++;assert.match(url,/type=MX/);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({Status:0,Answer:[{type:15,data:'10 mx.example.com.'}]})};}};
  const result=f.c.previewContactVerification({lookupMx:true});assert.equal(result.companies[0].emailDomainMxStatus,'MX_PRESENT');
  assert.equal(result.companies[0].emailDeliverabilityStatus,'UNVERIFIED');assert.equal(calls,1);assert.equal(result.summary.mxLookupPerformed,true);
});

test('MX failures remain UNKNOWN and no-MX never means undeliverable',()=>{
  const f=setup([prospect('No MX','nobody@example.invalid','','','')]);
  f.c.UrlFetchApp={fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({Status:0})})};
  const result=f.c.previewContactVerification({lookupMx:true});assert.equal(result.companies[0].emailDomainMxStatus,'NO_MX');
  assert.equal(result.companies[0].emailDeliverabilityStatus,'UNVERIFIED');
  f.c.UrlFetchApp={fetch:()=>{throw new Error('private failure details');}};
  assert.equal(f.c.previewContactVerification({lookupMx:true}).companies[0].emailDomainMxStatus,'UNKNOWN');
});

test('configured verifier adapter is opt-in and maps only explicit provider results',()=>{
  const f=setup([prospect('Example Co','bob@example.com','','','')]);let calls=0,headers='';
  f.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>({EMAIL_VERIFIER_API_URL:'https://verifier.example/api',EMAIL_VERIFIER_API_TOKEN:'secret-value'})[key]||''})};
  f.c.UrlFetchApp={fetch:(url,options)=>{calls++;headers=JSON.stringify(options.headers);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({status:'deliverable'})};}};
  assert.equal(f.c.verifyEmailWithConfiguredProvider_('bob@example.com'),'DELIVERABLE');assert.equal(calls,1);assert.equal(headers.includes('secret-value'),true);
  assert.equal(f.logs.some(line=>line.includes('secret-value')),false);
});

test('verification preview computes actual coverage from the 20-row contact research CSV',()=>{
  const file=path.join(__dirname,'..','pilot-data','arizona-contact-enrichment-preview.csv');
  const csv=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>line.split(','));
  const records=csv.slice(1).map(fields=>{
    const row=Array(42).fill('');row[0]=fields[1];row[2]=fields[11];row[3]=fields[4];row[4]=fields[9];row[5]=fields[8];row[6]='UNKNOWN';row[7]=fields[13];row[8]=fields[6];row[18]=fields[15];row[24]=fields[0];row[25]=fields[17];
    row[26]=fields[2];row[27]=fields[3];row[28]=fields[10];row[31]='UNVERIFIED';row[33]=fields[5];row[34]=fields[12];row[36]='UNVERIFIED';row[38]=fields[14];row[39]='';return row;
  });
  const f=setup(records),result=f.c.previewContactVerification();
  assert.deepEqual(JSON.parse(JSON.stringify({total:result.summary.totalCompanies,names:result.summary.namedPocs,companyEmails:result.summary.companyEmails,pocEmails:result.summary.pocEmails,companyPhones:result.summary.companyPhones,pocPhones:result.summary.directPocPhones,linkedin:result.summary.linkedInProfiles,sizes:result.summary.employeeSizes,average:result.summary.averageCompletenessScore,missingDomains:result.summary.missingCompanyDomains})),{total:20,names:5,companyEmails:12,pocEmails:1,companyPhones:11,pocPhones:1,linkedin:0,sizes:0,average:21,missingDomains:20},JSON.stringify(result.companies.map(c=>[c.company,c.completenessScore,c.missingFields])));
});
