const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function loadEngine(){
  const root=path.join(__dirname,'..','apps-script');
  const context={URL,Date,JSON,Math,String,Number,Object,Array,RegExp,Error,console,Logger:{log(){}},Utilities:{getUuid(){return 'run-test';},parseCsv(){return [];}}};
  vm.createContext(context);
  ['Config.gs','Validation.gs','ICPScoring.gs','Sources.gs','CompanyResearch.gs','Deduplication.gs','Scheduler.gs'].forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file}));
  context.getSetting_=()=>60;
  return context;
}

const reviewed={companyName:'Example Skin',website:'https://example.com',city:'Phoenix',address:'Phoenix, AZ',industry:'Cosmetics & Skincare Brands',sourceUrl:'https://example.com/about',locationEvidenceUrl:'https://example.com/about',productEvidenceUrl:'https://example.com/shop',brandEvidence:'Official shop lists facial skincare products.',physicalProductsEvidence:'Official product page lists packaged face balm.',evidenceReviewed:true};

test('all Apps Script source files parse under the local JavaScript runtime',()=>{
  const root=path.join(__dirname,'..','apps-script');
  fs.readdirSync(root).filter(file=>file.endsWith('.gs')).forEach(file=>new vm.Script(fs.readFileSync(path.join(root,file),'utf8'),{filename:file}));
});

test('pilot qualification requires AZ location, official evidence URLs, and reviewed products',()=>{
  const c=loadEngine();
  assert.equal(c.qualifyPilotCandidate_(reviewed).qualified,true);
  assert.equal(c.qualifyPilotCandidate_(Object.assign({},reviewed,{city:'Austin',address:'Texas'})).qualified,false);
  assert.equal(c.qualifyPilotCandidate_(Object.assign({},reviewed,{productEvidenceUrl:''})).qualified,false);
  assert.equal(c.qualifyPilotCandidate_(Object.assign({},reviewed,{evidenceReviewed:false})).qualified,false);
});

test('runPilot defaults to no-write dry run and does not mutate queue or log sheets',()=>{
  const c=loadEngine();let appended=0,marked=0,logged=0;
  c.loadPendingCandidates_=()=>[Object.assign({},reviewed,{_queueRow:2})];
  c.checkDuplicate=()=>({duplicate:false});c.appendProspects=()=>{appended++;return 1;};
  c.markQueue_=()=>{marked++;};c.writeRunLog_=()=>{logged++;};
  c.departmentForTitle_=()=>'';
  c.researchDecisionMakers=()=>({pocName:'',designation:'',department:'',email:'',pocPhone:'',linkedin:''});
  const result=c.runPilot();
  assert.equal(result.status,'DRY_RUN');assert.equal(result.candidates[0].status,'WOULD_APPEND');
  assert.equal(appended,0);assert.equal(marked,0);assert.equal(logged,0);
});

test('pilot refuses writes unless a deliberate confirmation flag is supplied',()=>{
  const c=loadEngine();
  assert.throws(()=>c.runPilot({dryRun:false}),/confirmWrite/);
});

test('CSV importer maps evidence fields without synthesizing contact data',()=>{
  const c=loadEngine();let captured;
  c.Utilities.parseCsv=()=>[
    ['Company Name','Website','City','Arizona Evidence URL','Product Evidence URL','Physical Products Evidence','Evidence Reviewed','POC Name','POC Email ID'],
    ['Example Skin','https://example.com','Phoenix','https://example.com/about','https://example.com/shop','Face balm product page','YES','','']
  ];
  c.enqueueCandidate_=candidate=>{captured=candidate;return true;};
  assert.equal(c.importCandidatesCsv('sample','MANUAL_OFFICIAL_WEB_REVIEW'),1);
  assert.equal(captured.locationEvidenceUrl,'https://example.com/about');
  assert.equal(captured.evidenceReviewed,true);assert.equal(captured.pocName,'');assert.equal(captured.email,'');
});

function parseCsvFixture(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}
    else if(ch==='"')quoted=true;
    else if(ch===','){row.push(field);field='';}
    else if(ch==='\n'){row.push(field);rows.push(row);row=[];field='';}
    else if(ch!=='\r')field+=ch;
  }
  if(field||row.length){row.push(field);rows.push(row);}
  return rows;
}

test('pilot CSV contains 20 fully evidenced, import-compatible candidates that pass the engine gates',()=>{
  const c=loadEngine(),file=path.join(__dirname,'..','pilot-data','arizona-physical-product-candidates.csv');
  const rows=parseCsvFixture(fs.readFileSync(file,'utf8'));let accepted=[];
  c.Utilities.parseCsv=()=>rows;c.enqueueCandidate_=candidate=>{accepted.push(candidate);return true;};
  assert.equal(c.importCandidatesCsv('pilot','MANUAL_OFFICIAL_WEB_REVIEW'),20);
  assert.equal(accepted.length,20);
  accepted.forEach(candidate=>assert.equal(c.qualifyPilotCandidate_(candidate).qualified,true,`${candidate.companyName}: ${c.qualifyPilotCandidate_(candidate).reasons.join('; ')}`));
  assert.ok(accepted.every(candidate=>candidate.pocName===''&&candidate.email===''&&candidate.pocPhone===''));
});

test('CSV preview is read-only and qualifies the pilot without queue or prospect writes',()=>{
  const c=loadEngine(),file=path.join(__dirname,'..','pilot-data','arizona-physical-product-candidates.csv');
  c.Utilities.parseCsv=()=>parseCsvFixture(fs.readFileSync(file,'utf8'));
  let writes=0;
  const prospects={getLastRow:()=>1,appendRow(){writes++;throw new Error('Preview attempted a write');}};
  c.getSpreadsheet_=()=>({getSheetByName:()=>prospects});
  const result=c.previewCandidatesCsv('pilot','MANUAL_OFFICIAL_WEB_REVIEW');
  assert.equal(result.dryRun,true);assert.equal(result.summary.input,20);assert.equal(result.summary.qualified,20);
  assert.equal(result.summary.needsReview,0);assert.equal(writes,0);
});

test('previewArizonaPilot reads only the configured Drive CSV and calls the read-only preview',()=>{
  const c=loadEngine();let calledWith=null;
  c.PropertiesService={getScriptProperties:()=>({getProperty:key=>key==='PILOT_CSV_FILE_ID'?'drive-csv-id':''})};
  c.DriveApp={getFileById:id=>({getName:()=> 'pilot.csv',getMimeType:()=> 'text/csv',getBlob:()=>({getDataAsString:encoding=>{assert.equal(encoding,'UTF-8');return 'csv-bytes';}})})};
  c.previewCandidatesCsv=(text,label)=>{calledWith={text,label};return {dryRun:true};};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','apps-script','PilotPreview.gs'),'utf8'),c,{filename:'PilotPreview.gs'});
  assert.equal(c.previewArizonaPilot().dryRun,true);
  assert.deepEqual(calledWith,{text:'csv-bytes',label:'MANUAL_OFFICIAL_WEB_REVIEW'});
  c.PropertiesService={getScriptProperties:()=>({getProperty:()=>''})};
  assert.throws(()=>c.previewArizonaPilot(),/PILOT_CSV_FILE_ID/);
});

function loadImportEngine(){
  const c=loadEngine();
  ['PilotPreview.gs','SheetsStorage.gs','Logging.gs'].forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..','apps-script',file),'utf8'),c,{filename:file}));
  c.stableId_=value=>'id-'+String(value).replace(/[^a-z0-9]/gi,'').slice(0,20);
  c.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};
  c.now_=()=>new Date('2026-10-14T00:00:00Z');
  return c;
}

function configureImportFixture(c,rows){
  c.Utilities.parseCsv=()=>rows.map(row=>row.slice());
  c.PropertiesService={getScriptProperties:()=>({getProperty:key=>key==='PILOT_CSV_FILE_ID'?'drive-csv-id':''})};
  c.DriveApp={getFileById:id=>({getName:()=>{assert.equal(id,'drive-csv-id');return 'pilot.csv';},getMimeType:()=> 'text/csv',getBlob:()=>({getDataAsString:()=> 'csv-content'})})};
  const sheets={};
  function fakeSheet(name,headers){
    return sheets[name]={rows:[headers.slice()],getLastRow(){return this.rows.length;},getRange(row,col,numRows,numCols){return {getValues:()=>this.rows.slice(row-1,row-1+numRows).map(r=>r.slice(col-1,col-1+numCols))};},getDataRange(){return {getValues:()=>this.rows};},appendRow(row){this.rows.push(row.slice());}};
  }
  const prospects=fakeSheet('Prospects',c.PE.TAB_HEADERS.Prospects);
  fakeSheet('ICP Notes',c.PE.TAB_HEADERS['ICP Notes']);
  fakeSheet('Run Logs',c.PE.TAB_HEADERS['Run Logs']);
  c.getSpreadsheet_=()=>({getSheetByName:name=>sheets[name]||null});
  return {sheets,prospects};
}

test('approved Arizona import appends only qualified evidence-backed rows, logs counts, and is idempotent',()=>{
  const c=loadImportEngine(),file=path.join(__dirname,'..','pilot-data','arizona-physical-product-candidates.csv');
  const rows=parseCsvFixture(fs.readFileSync(file,'utf8'));
  const fake=configureImportFixture(c,rows);
  const first=c.importApprovedArizonaPilot();
  assert.deepEqual(JSON.parse(JSON.stringify(first.summary)),{input:20,qualified:20,imported:20,skipped:0,rejected:0,failed:0});
  assert.equal(fake.prospects.rows.length,21);
  fake.prospects.rows.slice(1).forEach(row=>{
    assert.equal(row.length,26);assert.ok(row[0]);assert.ok(row[13]);assert.ok(row[17]);
    assert.equal(row[1],'');assert.equal(row[2],'');assert.equal(row[4],'');assert.equal(row[5],'');assert.equal(row[6],'UNKNOWN');assert.equal(row[7],'');assert.equal(row[8],'');
    assert.equal(row[19],'UNVERIFIED');assert.equal(row[20],'UNVERIFIED');assert.equal(row[21],'QUALIFIED');
    assert.match(row[25],/Arizona location evidence: https:\/\//);assert.match(row[25],/Physical product evidence: https:\/\//);assert.match(row[25],/Source ID: MANUAL_OFFICIAL_WEB_REVIEW/);
  });
  assert.deepEqual(fake.sheets['Prospects'].rows[0],c.PE.TAB_HEADERS.Prospects);
  const second=c.importApprovedArizonaPilot();
  assert.deepEqual(JSON.parse(JSON.stringify(second.summary)),{input:20,qualified:20,imported:0,skipped:20,rejected:0,failed:0});
  assert.equal(fake.prospects.rows.length,21);
  assert.match(fake.sheets['Run Logs'].rows[1][13],/imported=20 skipped=0 rejected=0 failed=0/);
});

test('approved Arizona import rejects unsupported source rows and refuses a changed Prospects header',()=>{
  const file=path.join(__dirname,'..','pilot-data','arizona-physical-product-candidates.csv');
  const rows=parseCsvFixture(fs.readFileSync(file,'utf8'));
  const c=loadImportEngine(),fake=configureImportFixture(c,rows.map(row=>row.slice()));
  fake.prospects.rows[0][0]='Unexpected header';
  assert.throws(()=>c.importApprovedArizonaPilot(),/headers do not match/);
  assert.equal(fake.prospects.rows.length,1);

  const c2=loadImportEngine(),rows2=rows.map(row=>row.slice());
  rows2[1][11]='UNAPPROVED_SOURCE';
  const fake2=configureImportFixture(c2,rows2);
  const result=c2.importApprovedArizonaPilot();
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary)),{input:20,qualified:19,imported:19,skipped:0,rejected:1,failed:0});
  assert.equal(fake2.prospects.rows.length,20);
});

test('approved Arizona import reports candidate-level failures and continues safely',()=>{
  const c=loadImportEngine(),file=path.join(__dirname,'..','pilot-data','arizona-physical-product-candidates.csv');
  const rows=parseCsvFixture(fs.readFileSync(file,'utf8'));
  configureImportFixture(c,rows);
  const append=c.appendProspects;
  const failedCompany=rows[1][0];
  c.appendProspects=records=>records[0].companyName===failedCompany?(()=>{throw new Error('simulated append failure');})():append(records);
  const result=c.importApprovedArizonaPilot();
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary)),{input:20,qualified:20,imported:19,skipped:0,rejected:0,failed:1});
});

test('stable lead IDs use deterministic SHA-256 digests',()=>{
  const c=loadEngine();
  c.Utilities.DigestAlgorithm={SHA_256:'SHA-256'};c.Utilities.Charset={UTF_8:'UTF-8'};
  c.Utilities.computeDigest=(algorithm,value,charset)=>{assert.equal(algorithm,'SHA-256');assert.equal(value,'same-input');assert.equal(charset,'UTF-8');return [1,2,255];};
  assert.equal(c.stableId_('same-input'),'0102ff');
});

test('application duplicate check blocks existing company domains, emails, and POC phone numbers',()=>{
  const c=loadEngine();
  const values=Array.from({length:2},()=>Array(26).fill(''));
  values[1][2]='+14805550123';values[1][4]='buyer@example.com';values[1][9]='https://example.com';values[1][10]='example.com';values[1][11]='Phoenix';
  const sheet={getLastRow:()=>2,getDataRange:()=>({getValues:()=>values})};
  c.getSpreadsheet_=()=>({getSheetByName:()=>sheet});
  assert.equal(c.checkDuplicate({website:'https://example.com/shop'}).reason,'company domain');
  assert.equal(c.checkDuplicate({website:'https://other.com',email:'buyer@example.com'}).reason,'contact email');
  assert.equal(c.checkDuplicate({website:'https://other.com',pocPhone:'(480) 555-0123'}).reason,'POC phone');
});

test('decision-maker details stay blank without a public contact-source URL',()=>{
  const c=loadEngine();
  assert.equal(c.researchDecisionMakers({pocName:'Alex',email:'a@example.com'}).pocName,'');
  assert.equal(c.researchDecisionMakers({pocName:'Alex',email:'a@example.com',contactSourceUrl:'https://example.com/contact'}).pocName,'Alex');
});

test('append path keeps 26 columns and records public contact data as listed, never provider-verified',()=>{
  const c=loadEngine(),sheets={};
  function fakeSheet(name){return sheets[name]={rows:[],getLastRow(){return this.rows.length;},getDataRange(){return {getValues:()=>this.rows};},appendRow(row){this.rows.push(row.slice());}};}
  const prospects=fakeSheet('Prospects'),notes=fakeSheet('ICP Notes');
  c.getSpreadsheet_=()=>({getSheetByName:name=>sheets[name]});c.stableId_=value=>'id-'+String(value).slice(0,12);
  c.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};c.now_=()=>new Date('2026-10-14T00:00:00Z');
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','apps-script','SheetsStorage.gs'),'utf8'),c,{filename:'SheetsStorage.gs'});
  const record=Object.assign({},reviewed,{contactSourceUrl:'https://example.com/contact',email:'owner@example.com',emailSourceUrl:'https://example.com/contact',pocName:'Publicly Listed Owner',designation:'Owner',pocPhone:'4805550123',phoneSourceUrl:'https://example.com/contact',packagingOpportunity:'Product packaging fit'});
  assert.equal(c.appendProspects([record]),1);
  const row=prospects.rows[0];assert.equal(row.length,26);
  assert.equal(row[1],'Owner');assert.equal(row[2],'+14805550123');assert.equal(row[4],'owner@example.com');assert.equal(row[8],'Publicly Listed Owner');
  assert.equal(row[19],'SOURCE_LISTED');assert.equal(row[20],'SOURCE_LISTED');
  assert.equal(row[19]==='PROVIDER_VERIFIED'||row[20]==='PROVIDER_VERIFIED',false);
  assert.equal(notes.rows.length,1);
});

test('live Prospects schema remains exactly 26 columns',()=>{
  const c=loadEngine();
  assert.equal(c.PE.TAB_HEADERS.Prospects.length,26);
  assert.deepEqual(Array.from(c.PE.TAB_HEADERS.Prospects.slice(0,8)),['Company Name','Designation','POC Contact Number','Company Contact Number','POC Email ID','Department','Employee Size','LI POC Profile']);
});
