const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function parseCsv(text){
  const out=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(field);field='';}else if(ch==='\n'){row.push(field);out.push(row);row=[];field='';}else if(ch!=='\r')field+=ch;}
  if(field||row.length){row.push(field);out.push(row);}return out;
}
function fixture(){
  const root=path.join(__dirname,'..','apps-script');
  const c={URL,Date,JSON,Math,String,Number,Object,Array,RegExp,Error,console,Logger:{log(){}},Utilities:{parseCsv},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})}};
  vm.createContext(c);['Config.gs','ContactEnrichment.gs'].forEach(f=>vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c,{filename:f}));
  const rows=[c.PE.TAB_HEADERS.Prospects.slice()];
  const values=parseCsv(fs.readFileSync(path.join(__dirname,'..','pilot-data','arizona-contact-enrichment-preview.csv'),'utf8'));
  values.slice(1).forEach(r=>{const lead=r[0],company=r[1];const seed=Array(26).fill('');seed[0]=company;seed[24]=lead;rows.push(seed);});
  const sheet={rows,getLastRow(){return rows.length;},getRange(r,col,nr,nc){return {getValues:()=>rows.slice(r-1,r-1+nr).map(x=>x.slice(col-1,col-1+nc)),setValue(v){rows[r-1][col-1]=v;}};}};
  c.getSpreadsheet_=()=>({getSheetByName:n=>n==='Prospects'?sheet:null});return {c,sheet,csv:fs.readFileSync(path.join(__dirname,'..','pilot-data','arizona-contact-enrichment-preview.csv'),'utf8'),values};
}

test('enrichment CSV has 20 rows, exact headers, and correctly separates company vs POC fields',()=>{
  const f=fixture();assert.equal(f.values.length,21);assert.deepEqual(f.values[0],Array.from(f.c.CONTACT_ENRICHMENT_HEADERS_));
  f.values.slice(1).forEach((row,i)=>assert.equal(row.length,18,`CSV row ${i+2} width`));
  const bob=f.values.find(r=>r[1]==='Arizona Salsa & Spice Company');assert.equal(bob[6],'Bob Roberti');assert.equal(bob[9],'arizonaspiceco@gmail.com');assert.equal(bob[11],'(480) 688-6798 Cell');
  const simple=f.values.find(r=>r[1]==='Simple Blossom Skincare');assert.equal(simple[2],'simpleblossomskincare@gmail.com');assert.equal(simple[9],'');
  assert.equal(f.values.slice(1).filter(r=>r[13]).length,0);
});

test('preview matches 20 unique existing Lead IDs and performs no writes',()=>{
  const f=fixture();let writes=0;const set=f.sheet.getRange;f.sheet.getRange=(...args)=>{const x=set(...args);if(x.setValue)x.setValue=v=>{writes++;};return x;};
  const result=f.c.previewContactEnrichmentCsv(f.csv);assert.equal(result.dryRun,true);assert.equal(result.summary.input,20);assert.equal(result.summary.matched,20,JSON.stringify(result.records.filter(r=>!r.valid)));assert.equal(result.summary.rejected,0);assert.equal(writes,0);
});

test('Drive preview reads the dedicated contact CSV property and stays read-only',()=>{
  const f=fixture();let previewed='';f.c.PropertiesService={getScriptProperties:()=>({getProperty:k=>k==='CONTACT_ENRICHMENT_CSV_FILE_ID'?'contact-csv-id':''})};
  f.c.DriveApp={getFileById:id=>({getName:()=>{assert.equal(id,'contact-csv-id');return 'contact-enrichment.csv';},getMimeType:()=> 'text/csv',getBlob:()=>({getDataAsString:encoding=>{assert.equal(encoding,'UTF-8');previewed=f.csv;return f.csv;}})})};
  const result=f.c.previewArizonaContactEnrichment();assert.equal(result.summary.matched,20);assert.equal(previewed,f.csv);
  f.c.PropertiesService={getScriptProperties:()=>({getProperty:()=>''})};assert.throws(()=>f.c.previewArizonaContactEnrichment(),/CONTACT_ENRICHMENT_CSV_FILE_ID/);
});

test('update fills only blank cells, keeps company email out of POC Email, and is idempotent',()=>{
  const f=fixture();const row=f.sheet.rows[1];row[4]='already@there.example';row[2]='(602) 555-0111';row[19]='UNVERIFIED';const beforeEmail=row[4],beforePhone=row[2];
  const first=f.c.updateExistingProspectsContactsCsv(f.csv);assert.equal(first.summary.updated,20);assert.equal(row[4],beforeEmail);assert.equal(row[2],beforePhone);
  assert.match(row[25],/simpleblossomskincare@gmail.com/);assert.equal(row[19],'UNVERIFIED');
  const second=f.c.updateExistingProspectsContactsCsv(f.csv);assert.equal(second.summary.updated,0);assert.equal(f.sheet.rows[1][4],beforeEmail);assert.equal(f.sheet.rows[1][2],beforePhone);
});

test('preview rejects duplicate or mismatched Lead IDs and source-less POC data',()=>{
  const f=fixture(),parsed=parseCsv(f.csv);const duplicate=parsed[1].slice();parsed.push(duplicate);
  let result=f.c.previewContactEnrichmentCsv(parsed.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n'));
  assert.equal(result.summary.rejected,1);
  const wrong=parsed.slice(0,-1);wrong[1][1]='Different Company';
  result=f.c.previewContactEnrichmentCsv(wrong.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n'));
  assert.equal(result.summary.rejected,1);
  const noSource=parsed.slice(0,-1);noSource[1][6]='Unverified Person';noSource[1][15]='';
  result=f.c.previewContactEnrichmentCsv(noSource.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n'));
  assert.equal(result.summary.rejected,1);
});

test('duplicate POC emails and phone numbers across CSV/live rows are rejected',()=>{
  const f=fixture(),parsed=parseCsv(f.csv),bob=parsed.findIndex(r=>r[1]==='Arizona Salsa & Spice Company');
  const duplicate=parsed[1].slice();duplicate[9]=parsed[bob][9];duplicate[10]=parsed[bob][10];parsed.push(duplicate);
  const duplicateCsv=parsed.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const result=f.c.previewContactEnrichmentCsv(duplicateCsv);assert.equal(result.summary.rejected,1);
  f.sheet.rows[2][4]='arizonaspiceco@gmail.com';
  const update=f.c.updateExistingProspectsContactsCsv(f.csv);assert.equal(update.summary.rejected,1);
});

test('update refuses changed live headers without modifying rows',()=>{
  const f=fixture(),before=JSON.stringify(f.sheet.rows);f.sheet.rows[0][0]='unexpected';
  assert.throws(()=>f.c.updateExistingProspectsContactsCsv(f.csv),/headers do not match/);
  assert.equal(f.sheet.rows.length,21);assert.equal(JSON.stringify(f.sheet.rows.slice(1)),JSON.stringify(JSON.parse(before).slice(1)));
});
