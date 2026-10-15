/** Read-only preview and blank-only data-quality updates for the existing 42-column Prospects schema. */
function previewDataQualityImprovements(options) {
  var plan = buildDataQualityImprovementPlan_(options || {});
  Logger.log('DATA_QUALITY_PREVIEW ' + JSON.stringify(plan.summary));
  return plan;
}

/** Manual-only updater. Never appends records or overwrites populated cells. */
function applyDataQualityImprovements(options) {
  options = options || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var plan = buildDataQualityImprovementPlan_(options);
    var sheet = getSpreadsheet_().getSheetByName('Prospects');
    var live = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,1,sheet.getLastRow()-1,42).getValues();
    var indexByLeadId = {};
    live.forEach(function(row,index) {
      var id = String(row[24] || '').trim();
      if (id) (indexByLeadId[id] = indexByLeadId[id] || []).push(index);
    });
    var summary = {input:plan.summary.totalRecords,matched:0,updatedRows:0,fieldsUpdated:0,fieldsPreserved:0,skipped:0,rejected:0,failed:0};
    plan.records.forEach(function(record) {
      if (!record.leadId || !indexByLeadId[record.leadId] || indexByLeadId[record.leadId].length !== 1) { summary.rejected++; return; }
      var idx = indexByLeadId[record.leadId][0], sheetRow = idx + 2;
      var current = sheet.getRange(sheetRow,1,1,42).getValues()[0];
      if (String(current[24] || '').trim() !== record.leadId || String(current[0] || '').trim() !== record.company) { summary.rejected++; return; }
      summary.matched++;
      var rowChanged = false;
      record.changes.forEach(function(change) {
        try {
          var currentValue = sheet.getRange(sheetRow,change.column,1,1).getValue();
          if (String(currentValue === null || currentValue === undefined ? '' : currentValue).trim() !== '') { summary.fieldsPreserved++; return; }
          sheet.getRange(sheetRow,change.column,1,1).setValue(change.newValue);
          summary.fieldsUpdated++; rowChanged = true;
        } catch (error) { summary.failed++; }
      });
      if (rowChanged) summary.updatedRows++;
      else if (!record.changes.length) summary.skipped++;
    });
    Logger.log('DATA_QUALITY_UPDATE ' + JSON.stringify(summary));
    return {dryRun:false,summary:summary};
  } finally { lock.releaseLock(); }
}

function buildDataQualityImprovementPlan_(options) {
  var sheet = getSpreadsheet_().getSheetByName('Prospects');
  if (!sheet) throw new Error('Prospects sheet is missing.');
  var expected = PE.PROSPECTS_FULL_HEADERS;
  if (sheet.getLastColumn() !== 42) throw new Error('Expected exactly 42 Prospects columns; no data-quality plan was produced.');
  var headers = sheet.getRange(1,1,1,42).getDisplayValues()[0];
  if (headers.join('\u001f') !== expected.join('\u001f')) throw new Error('Prospects headers do not match the verified 42-column schema.');
  var values = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,1,sheet.getLastRow()-1,42).getValues();
  var ids = {};
  values.forEach(function(row) { var id=String(row[24]||'').trim(); if(id)(ids[id]=(ids[id]||0)+1); });
  var mxCache = {}, records = [], changesByField = {}, duplicateIds = Object.keys(ids).filter(function(id){return ids[id]!==1;});
  if (duplicateIds.length) throw new Error('Duplicate Lead IDs found; refusing to create an ambiguous update plan.');
  values.forEach(function(row) {
    var record = buildDataQualityRecord_(row, !!options.lookupMx, mxCache);
    records.push(record);
    record.changes.forEach(function(change){changesByField[change.header]=(changesByField[change.header]||0)+1;});
  });
  return {dryRun:true,summary:{totalRecords:records.length,recordsWithChanges:records.filter(function(r){return r.changes.length;}).length,proposedCellUpdates:records.reduce(function(n,r){return n+r.changes.length;},0),changesByField:changesByField,cityReviewedUnknown:records.filter(function(r){return r.cityReview==='REVIEWED_UNKNOWN';}).length,mxLookupPerformed:!!options.lookupMx},records:records};
}

function buildDataQualityRecord_(row,lookupMx,mxCache) {
  var id=String(row[24]||'').trim(), company=String(row[0]||'').trim();
  if(!id||!company) throw new Error('A Prospects row is missing Company Name or Lead ID.');
  var contactSource=String(row[18]||'').trim(), notes=String(row[25]||'');
  var website=String(row[9]||'').trim(), domain=extractValidatedCompanyDomain_(website);
  var companyEmail=String(row[26]||'').trim() || extractPublicCompanyEmail_(notes).email;
  var emailSource=String(row[27]||'').trim() || extractPublicCompanyEmail_(notes).source || (companyEmail?firstHttpSource_(contactSource):'');
  var pocEmail=String(row[4]||'').trim();
  if(isGenericCompanyEmail_(pocEmail)) pocEmail='';
  var companyPhone=String(row[3]||'').trim(), pocPhone=String(row[2]||'').trim();
  var companyPhoneSource=String(row[33]||'').trim() || (companyPhone?firstHttpSource_(contactSource):'');
  var pocEmailSource=String(row[28]||'').trim() || (pocEmail?firstHttpSource_(contactSource):'');
  var pocPhoneSource=String(row[34]||'').trim() || (pocPhone?firstHttpSource_(contactSource):'');
  var proposed=row.slice(), changes=[];
  function offer(column,header,value,sourceUrl,reason) {
    if(value===null||value===undefined||String(value).trim()==='')return;
    if(String(row[column-1]===null||row[column-1]===undefined?'':row[column-1]).trim()!=='')return;
    changes.push({column:column,header:header,oldValue:'',newValue:value,sourceUrl:sourceUrl||'',reason:reason||'Evidence already present in the row or cited source.'});
    proposed[column-1]=value;
  }
  offer(11,'Company Domain',domain,website,'Normalized hostname extracted from the official Company Website URL.');
  offer(27,'Company Email',companyEmail,emailSource,'Public company-level email already recorded in Notes; not labeled as a POC email.');
  offer(28,'Company Email Source URL',emailSource,emailSource,'URL explicitly paired with the public company email in Notes or row evidence.');
  offer(29,'POC Email Source URL',pocEmailSource,pocEmailSource,'Existing named-contact email; source taken from the row’s professional contact evidence.');
  offer(34,'Company Phone Source URL',companyPhoneSource,companyPhoneSource,'Existing company phone; source taken from the row’s contact evidence.');
  offer(35,'POC Phone Source URL',pocPhoneSource,pocPhoneSource,'Existing direct POC phone; source taken from the row’s professional contact evidence.');
  var emails=[companyEmail,pocEmail].filter(Boolean);
  var syntax=emails.length?(emails.every(function(e){return validateEmail(e).status==='FORMAT_VALID';})?'VALID_FORMAT':'INVALID_FORMAT'):'MISSING';
  offer(30,'Email Syntax Status',syntax,emailSource||pocEmailSource,'Syntactic check only; does not establish mailbox existence or deliverability.');
  var mx=emails.length?(lookupMx?aggregateMxStatus_(emails,true,mxCache):'UNKNOWN'):'MISSING';
  offer(31,'Email Domain MX Status',mx,emailSource||pocEmailSource,lookupMx?'DNS MX presence only; not mailbox deliverability.':'Not queried; no external DNS lookup was made in this preview.');
  offer(32,'Email Deliverability Status','UNVERIFIED',emailSource||pocEmailSource,'No independent email verifier result is present.');
  var phoneChecks=[companyPhone,pocPhone].filter(Boolean).map(validatePhone);
  var phoneFormat=phoneChecks.length?(phoneChecks.every(function(p){return p.status==='FORMAT_VALID';})?'VALID_FORMAT':'INVALID_FORMAT'):'MISSING';
  offer(36,'Phone Format Status',phoneFormat,companyPhoneSource||pocPhoneSource,'Format validation only; does not establish that the number is active or assigned to this contact.');
  offer(37,'Phone Activity Status','UNVERIFIED',companyPhoneSource||pocPhoneSource,'No independent phone-status result is present.');
  if(typeof contactVerificationRecord_==='function') {
    var quality=contactVerificationRecord_(proposed,42,false,{}).completenessScore;
    offer(41,'Contact Completeness Score',quality,'','Score uses populated and sourced values; it is not a verification score.');
  }
  var city=String(row[11]||'').trim();
  return {leadId:id,company:company,changes:changes,cityReview:city?'ALREADY_POPULATED':'REVIEWED_UNKNOWN',companyDomain:domain,companyEmail:companyEmail,emailSourceUrl:emailSource,companyPhone:companyPhone,companyPhoneSourceUrl:companyPhoneSource,pocEmail:pocEmail,pocEmailSourceUrl:pocEmailSource,pocPhone:pocPhone,pocPhoneSourceUrl:pocPhoneSource,notes:city?'':'Official pages reviewed; exact operating city not publicly established, so leave Arizona City blank.'};
}

function extractValidatedCompanyDomain_(website) {
  var input=String(website||'').trim();
  if(!input)return '';
  // Apps Script V8 does not expose the standard URL Web API. Parse only an
  // HTTP(S) authority here so the same safe extraction works in GAS and Node.
  if(!/^https?:\/\//i.test(input))input='https://'+input;
  var match=input.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);
  if(!match)return '';
  var authority=String(match[1]||'').toLowerCase();
  if(authority.indexOf('@')>=0)return '';
  var host=authority;
  var portMatch=authority.match(/^([^:]+):(\d{1,5})$/);
  if(portMatch) {
    var port=Number(portMatch[2]);
    if(port<1||port>65535)return '';
    host=portMatch[1];
  } else if(authority.indexOf(':')>=0) return '';
  host=host.replace(/^www\./,'').replace(/\.$/,'');
  if(host.length>253||host.indexOf('.')<1||!host.split('.').every(function(label){return label.length>0&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);}))return '';
  return host;
}

function extractPublicCompanyEmail_(notes) {
  var text=String(notes||'');
  var match=text.match(/Public company email\s*\([^)]*\)\s*:\s*([^\s|]+)\s+(?:[—–-]|â€”)\s*(https?:\/\/[^\s|]+)/i);
  if(!match) return {email:'',source:''};
  var email=String(match[1]||'').replace(/[),.;]+$/,'').trim();
  return validateEmail(email).status==='FORMAT_VALID'?{email:email,source:String(match[2]||'').replace(/[),.;]+$/,'').trim()}:{email:'',source:''};
}
