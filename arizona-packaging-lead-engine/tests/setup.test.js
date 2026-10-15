const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.join(__dirname, '..');
const expectedProspects = [
  'Company Name','Designation','POC Contact Number','Company Contact Number','POC Email ID','Department','Employee Size','LI POC Profile',
  'POC Name','Company Website','Company Domain','Arizona City','Arizona Address','Industry','ICP Score','Brand Ownership Evidence',
  'Packaging Opportunity','Source URL','Contact Source URL','Email Verification Status','Phone Verification Status','Research Status',
  'Last Checked','Date Added','Lead ID','Notes'
];

class FakeSheet {
  constructor(name, data = []) { this.name = name; this.data = data; this.frozenRows = 0; }
  getName() { return this.name; }
  getLastRow() { for (let r=this.data.length-1;r>=0;r--) if ((this.data[r]||[]).some(v=>v!==''&&v!==null&&v!==undefined)) return r+1; return 0; }
  getLastColumn() { let max=0; this.data.forEach(row=>(row||[]).forEach((v,c)=>{if(v!==''&&v!==null&&v!==undefined)max=Math.max(max,c+1);})); return max; }
  getRange(row, col, rows=1, cols=1) {
    const sheet=this;
    return {
      getValues() { return Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>sheet.data[row-1+r]?.[col-1+c] ?? '')); },
      getDisplayValues() { return this.getValues().map(line=>line.map(v=>v===null||v===undefined?'':String(v))); },
      setValues(values) { values.forEach((line,r)=>line.forEach((value,c)=>{sheet.data[row-1+r] ||= [];sheet.data[row-1+r][col-1+c]=value;})); return this; },
      setValue(value) { sheet.data[row-1] ||= []; sheet.data[row-1][col-1]=value; return this; },
      getValue() { return sheet.data[row-1]?.[col-1] ?? ''; }
    };
  }
  appendRow(values) { this.data[this.getLastRow()] = values.slice(); }
  getDataRange() { return this.getRange(1,1,Math.max(1,this.getLastRow()),Math.max(1,this.getLastColumn())); }
  setFrozenRows(n) { this.frozenRows=n; }
}

class FakeSpreadsheet {
  constructor() { this.sheets=[new FakeSheet('Sheet1')]; this.active=null; }
  getName() { return 'Arizona Packaging Lead Engine'; }
  getId() { return 'test-spreadsheet-id'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/test-spreadsheet-id/edit'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find(sh=>sh.getName()===name)||null; }
  insertSheet(name) { const sh=new FakeSheet(name); this.sheets.push(sh); return sh; }
  setActiveSheet(sh) { this.active=sh; }
}

function createHarness(spreadsheet = new FakeSpreadsheet()) {
  const logged=[];
  const context={
    console,
    Logger:{log:value=>logged.push(String(value))},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})},
    SpreadsheetApp:{openById:id=>{context.openedId=id;return spreadsheet;},getActive:()=>spreadsheet},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(project,'apps-script','Config.gs'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(project,'apps-script','Setup.gs'),'utf8'),context);
  return {context,spreadsheet,logged};
}

test('setupSystem creates seven tabs, exact Prospects headers, and selects Prospects',()=>{
  const h=createHarness();
  const result=h.context.setupSystem();
  assert.equal(result.ok,true);
  assert.deepEqual(Array.from(h.context.PE.TABS),['Prospects','ICP Notes','Run Logs','Review Queue','Source Registry','Settings','Daily Summary']);
  assert.deepEqual(h.spreadsheet.getSheetByName('Prospects').getRange(1,1,1,26).getValues()[0],expectedProspects);
  assert.deepEqual(h.spreadsheet.getSheetByName('Prospects').getRange(1,27,1,16).getValues()[0],Array.from(h.context.PE.PROSPECTS_VERIFICATION_HEADERS));
  assert.equal(h.spreadsheet.getSheetByName('Prospects').getLastColumn(),42);
  assert.ok(h.spreadsheet.getSheetByName('Sheet1'));
  assert.equal(h.spreadsheet.active.getName(),'Prospects');
  assert.equal(result.diagnostic.setupStatus,'READY');
  assert.equal(h.context.openedId,'test-spreadsheet-id-1234567890');
});

test('verification schema appends after legacy columns without changing existing prospect values',()=>{
  const h=createHarness();
  h.context.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};
  h.context.initializeSheets();
  const sh=h.spreadsheet.getSheetByName('Prospects');
  const original=['Example Co','Owner','','602-555-0123','','Founder/Executive','UNKNOWN','','Casey','https://example.com'];
  sh.data.push(original.slice());
  h.context.ensureContactVerificationColumns();
  assert.deepEqual(sh.getRange(2,1,1,10).getValues()[0],original);
  assert.deepEqual(sh.getRange(1,1,1,26).getValues()[0],expectedProspects);
  assert.deepEqual(sh.getRange(1,27,1,16).getValues()[0],Array.from(h.context.PE.PROSPECTS_VERIFICATION_HEADERS));
});

test('verification schema refuses unknown trailing columns without overwriting them',()=>{
  const h=createHarness();h.context.initializeSheets();
  h.context.LockService={getScriptLock:()=>({waitLock(){},releaseLock(){}})};
  const sh=h.spreadsheet.getSheetByName('Prospects');sh.getRange(1,27).setValue('User Custom Column');
  assert.throws(()=>h.context.ensureContactVerificationColumns(),/Unexpected content after legacy Prospects columns/);
  assert.equal(sh.getRange(1,27).getValue(),'User Custom Column');
});

test('repeated setup is idempotent for settings and source rows',()=>{
  const h=createHarness();
  h.context.setupSystem();
  const settings=h.spreadsheet.getSheetByName('Settings').getLastRow();
  const sources=h.spreadsheet.getSheetByName('Source Registry').getLastRow();
  h.context.setupSystem();
  assert.equal(h.spreadsheet.getSheetByName('Settings').getLastRow(),settings);
  assert.equal(h.spreadsheet.getSheetByName('Source Registry').getLastRow(),sources);
});

test('source registry marks official-site review manual and uncompleted Overpass disabled',()=>{
  const h=createHarness();h.context.setupSystem();
  const rows=h.spreadsheet.getSheetByName('Source Registry').getDataRange().getValues();
  const manual=rows.find(row=>row[0]==='MANUAL_OFFICIAL_WEB_REVIEW');
  const overpass=rows.find(row=>row[0]==='OSM_OVERPASS_PILOT');
  assert.ok(manual);assert.equal(manual[4],'PUBLIC_PAGE_MANUAL_REVIEW_ONLY');
  assert.ok(overpass);assert.equal(overpass[4],'ONE_TIME_ONLY; QUERY_NOT_COMPLETED');assert.equal(overpass[9],'FALSE');
});

test('setup preserves mismatched existing sheet data and reports the conflict',()=>{
  const spreadsheet=new FakeSpreadsheet();
  const prospects=spreadsheet.insertSheet('Prospects');
  prospects.data=[['My existing heading'],['Keep this user value']];
  const h=createHarness(spreadsheet);
  assert.throws(()=>h.context.setupSystem(),/Header mismatch in tab "Prospects"/);
  assert.deepEqual(prospects.data,[['My existing heading'],['Keep this user value']]);
});

test('diagnostic reports spreadsheet identity and setup without credentials',()=>{
  const h=createHarness();
  h.context.initializeSheets();
  h.context.seedApprovedSources();
  const result=h.context.diagnoseSpreadsheet();
  assert.equal(result.name,'Arizona Packaging Lead Engine');
  assert.equal(result.id,'test-spreadsheet-id');
  assert.equal(result.setupStatus,'READY');
  assert.deepEqual(Object.keys(result).sort(),['configuredById','id','name','setupStatus','sheetNames','url'].sort());
  assert.ok(h.logged.some(line=>line.startsWith('SPREADSHEET_DIAGNOSTIC ')));
});
