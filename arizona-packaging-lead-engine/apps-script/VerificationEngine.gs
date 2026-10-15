/* Read-only contact audit and optional verification adapters. No verifier API is called by the preview. */
var PE_VERIFICATION_WEIGHTS_ = {
  companyEmail:10,companyEmailSource:5,pocName:10,pocEmail:10,pocEmailSource:5,
  companyPhone:10,companyPhoneSource:5,pocPhone:10,pocPhoneSource:5,
  linkedin:10,linkedinSource:5,employeeSize:10,employeeSizeSource:5
};

function previewContactVerification(options) {
  options = options || {};
  var sheet = getSpreadsheet_().getSheetByName('Prospects');
  if (!sheet) throw new Error('Prospects tab is missing.');
  var baseWidth = PE.PROSPECTS_LEGACY_WIDTH;
  var first = sheet.getRange(1,1,1,baseWidth).getDisplayValues()[0];
  if (first.join('\u001f') !== PE.TAB_HEADERS.Prospects.join('\u001f')) throw new Error('Legacy Prospects headers mismatch; audit stopped.');
  var lastColumn = sheet.getLastColumn();
  if (lastColumn !== baseWidth && lastColumn !== PE.PROSPECTS_FULL_HEADERS.length) throw new Error('Unexpected Prospects columns; audit stopped without modifying data.');
  if (lastColumn === PE.PROSPECTS_FULL_HEADERS.length) {
    var extra = sheet.getRange(1,baseWidth+1,1,PE.PROSPECTS_VERIFICATION_HEADERS.length).getDisplayValues()[0];
    if (extra.join('\u001f') !== PE.PROSPECTS_VERIFICATION_HEADERS.join('\u001f')) throw new Error('Verification extension headers mismatch; audit stopped.');
  }
  var rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,1,sheet.getLastRow()-1,lastColumn).getValues();
  var mxByDomain = {}, records = [];
  rows.forEach(function(row) {
    var parsed = contactVerificationRecord_(row,lastColumn,!!options.lookupMx,mxByDomain);
    records.push(parsed);
  });
  var summary = summarizeContactVerification_(records);
  summary.totalCompanies = records.length;
  summary.mxLookupPerformed = !!options.lookupMx;
  Logger.log('CONTACT_VERIFICATION_PREVIEW ' + JSON.stringify(summary));
  return {dryRun:true,summary:summary,companies:records};
}

function contactVerificationRecord_(row,lastColumn,lookupMx,mxByDomain) {
  var extra = lastColumn > PE.PROSPECTS_LEGACY_WIDTH ? row.slice(PE.PROSPECTS_LEGACY_WIDTH) : [];
  var name = String(row[0] || '').trim();
  var leadId = String(row[24] || '').trim();
  var notes = String(row[25] || '');
  var contactSource = String(row[18] || '').trim();
  var companyEmail = String(extra[0] || '').trim() || extractCompanyEmailFromNotes_(notes);
  var companyEmailSource = companyEmail ? (String(extra[1] || '').trim() || extractCompanyEmailSourceFromNotes_(notes) || firstHttpSource_(contactSource)) : '';
  var rawPocEmail = String(row[4] || '').trim();
  var genericPocEmail = rawPocEmail && isGenericCompanyEmail_(rawPocEmail);
  var pocEmail = genericPocEmail ? '' : rawPocEmail;
  var pocName = String(row[8] || '').trim();
  var companyPhone = String(row[3] || '').trim();
  var pocPhone = String(row[2] || '').trim();
  var linkedin = String(row[7] || '').trim();
  var employeeSize = String(row[6] || '').trim();
  if (/^(unknown|n\/a|not available|-)$/i.test(employeeSize)) employeeSize = '';
  var companyDomain=String(row[10]||'').trim();
  var companyWebsite=String(row[9]||'').trim();
  var arizonaCity=String(row[11]||'').trim();
  var pocEmailSource = String(extra[2] || '').trim() || (pocEmail ? firstHttpSource_(contactSource) : '');
  var companyPhoneSource = String(extra[7] || '').trim() || (companyPhone ? firstHttpSource_(contactSource) : '');
  var pocPhoneSource = String(extra[8] || '').trim() || (pocPhone ? firstHttpSource_(contactSource) : '');
  var linkedinSource = linkedin ? String(extra[12] || '').trim() : '';
  var employeeSizeSource = String(extra[13] || '').trim();
  var emails = [companyEmail,pocEmail].filter(Boolean);
  var syntax = emails.length ? (emails.every(function(email){return validateEmail(email).status === 'FORMAT_VALID';}) ? 'VALID_FORMAT' : 'INVALID_FORMAT') : 'MISSING';
  var mxStatus = aggregateMxStatus_(emails,lookupMx,mxByDomain);
  var deliverability = allowedEmailDeliverability_(String(extra[5] || '').trim());
  var companyPhoneValidation = companyPhone ? validatePhone(companyPhone) : {status:'UNVERIFIED',value:''};
  var pocPhoneValidation = pocPhone ? validatePhone(pocPhone) : {status:'UNVERIFIED',value:''};
  var phoneInputs = [companyPhoneValidation,pocPhoneValidation].filter(function(item){return item.value;});
  var phoneFormat = phoneInputs.length ? (phoneInputs.every(function(item){return item.status === 'FORMAT_VALID';}) ? 'VALID_FORMAT' : 'INVALID_FORMAT') : 'MISSING';
  var phoneActivity = allowedPhoneActivity_(String(extra[10] || '').trim());
  var hasSize = !!employeeSize;
  var fields = {
    companyEmail:!!companyEmail, companyEmailSource:validHttpSource_(companyEmailSource),
    pocName:!!pocName, pocEmail:!!pocEmail, pocEmailSource:validHttpSource_(pocEmailSource),
    companyPhone:!!companyPhone, companyPhoneSource:validHttpSource_(companyPhoneSource),
    pocPhone:!!pocPhone, pocPhoneSource:validHttpSource_(pocPhoneSource),
    linkedin:!!linkedin, linkedinSource:validHttpSource_(linkedinSource),
    employeeSize:hasSize, employeeSizeSource:hasSize && validHttpSource_(employeeSizeSource)
  };
  var score = 0; Object.keys(PE_VERIFICATION_WEIGHTS_).forEach(function(key){if(fields[key])score+=PE_VERIFICATION_WEIGHTS_[key];});
  var missing = Object.keys(fields).filter(function(key){return !fields[key];});
  var verifiedEmails = emails.filter(function(email){return allowedEmailDeliverability_(String(extra[5] || '').trim()) === 'DELIVERABLE';}).length;
  return {
    leadId:leadId,company:name,companyEmail:companyEmail,companyEmailSourceUrl:companyEmailSource,
    pocName:pocName,pocEmail:pocEmail,pocEmailSourceUrl:pocEmailSource,
    companyPhone:companyPhoneValidation.value || companyPhone,companyPhoneSourceUrl:companyPhoneSource,
    pocPhone:pocPhoneValidation.value || pocPhone,pocPhoneSourceUrl:pocPhoneSource,
    linkedin:linkedin,linkedinSourceUrl:linkedinSource,employeeSize:employeeSize,employeeSizeSourceUrl:employeeSizeSource,
    emailSyntaxStatus:syntax,emailDomainMxStatus:mxStatus,emailDeliverabilityStatus:deliverability,
    phoneFormatStatus:phoneFormat,phoneActivityStatus:phoneActivity,
    emailLastVerified:String(extra[6] || '').trim(),phoneLastVerified:String(extra[11] || '').trim(),
    genericEmailInPocField:!!genericPocEmail,completenessScore:score,verifiedEmailCount:verifiedEmails,
    companyDomain:companyDomain,companyWebsite:companyWebsite,arizonaCity:arizonaCity,
    missingFields:missing,missingLegacyFields:[!companyDomain?'Company Domain':'',!arizonaCity?'Arizona City':''].filter(Boolean),
    verificationNotes:genericPocEmail?'Generic mailbox is present in POC Email ID; manual source review required.':''
  };
}

function summarizeContactVerification_(records) {
  var summary = {
    totalCompanies:records.length,namedPocs:0,companyEmails:0,pocEmails:0,companyPhones:0,directPocPhones:0,
    linkedInProfiles:0,employeeSizes:0,companyDomains:0,companyWebsites:0,missingCompanyDomains:0,missingArizonaCities:0,verifiedDeliverableEmails:0,verifiedActivePhones:0,
    sourceListedButNotVerified:0,averageCompletenessScore:0,missingByField:{},
    emailSyntaxStatusCounts:{},emailDomainMxStatusCounts:{},emailDeliverabilityStatusCounts:{},
    phoneFormatStatusCounts:{},phoneActivityStatusCounts:{},genericPocEmailFlags:0
  };
  records.forEach(function(record) {
    if(record.pocName)summary.namedPocs++;
    if(record.companyEmail)summary.companyEmails++;
    if(record.pocEmail)summary.pocEmails++;
    if(record.companyPhone)summary.companyPhones++;
    if(record.pocPhone)summary.directPocPhones++;
    if(record.linkedin)summary.linkedInProfiles++;
    if(record.employeeSize)summary.employeeSizes++;
    if(record.companyDomain)summary.companyDomains++;else summary.missingCompanyDomains++;
    if(record.companyWebsite)summary.companyWebsites++;
    if(!record.arizonaCity)summary.missingArizonaCities++;
    summary.verifiedDeliverableEmails+=record.verifiedEmailCount;
    if(record.phoneActivityStatus==='ACTIVE')summary.verifiedActivePhones++;
    if((record.companyEmail||record.pocEmail||record.companyPhone||record.pocPhone) && record.emailDeliverabilityStatus!=='DELIVERABLE' && record.phoneActivityStatus!=='ACTIVE')summary.sourceListedButNotVerified++;
    if(record.genericEmailInPocField)summary.genericPocEmailFlags++;
    summary.averageCompletenessScore+=record.completenessScore;
    countStatus_(summary.emailSyntaxStatusCounts,record.emailSyntaxStatus);
    countStatus_(summary.emailDomainMxStatusCounts,record.emailDomainMxStatus);
    countStatus_(summary.emailDeliverabilityStatusCounts,record.emailDeliverabilityStatus);
    countStatus_(summary.phoneFormatStatusCounts,record.phoneFormatStatus);
    countStatus_(summary.phoneActivityStatusCounts,record.phoneActivityStatus);
    record.missingFields.forEach(function(field){summary.missingByField[field]=(summary.missingByField[field]||0)+1;});
  });
  summary.averageCompletenessScore=records.length?Math.round(summary.averageCompletenessScore/records.length):0;
  return summary;
}

function countStatus_(counts,status){counts[status]=(counts[status]||0)+1;}
function isGenericCompanyEmail_(email){return /^(info|sales|support|contact|hello|admin|office|orders|service|marketing|wholesale|team|inquiries|enquiries)([+._-].*)?@/i.test(String(email||'').trim());}
function extractCompanyEmailFromNotes_(notes){var m=String(notes||'').match(/Public company email \([^)]*\):\s*([^\s|]+)\s*[—-]\s*(https?:\/\/[^\s|]+)/i);return m?m[1]:'';}
function extractCompanyEmailSourceFromNotes_(notes){var m=String(notes||'').match(/Public company email \([^)]*\):\s*[^\s|]+\s*[—-]\s*(https?:\/\/[^\s|]+)/i);return m?m[1]:'';}
function firstHttpSource_(value){var list=String(value||'').split(/\s*\|\s*/);for(var i=0;i<list.length;i++)if(validHttpSource_(list[i]))return list[i];return '';}
function validHttpSource_(value){return /^https?:\/\/[^\s]+$/i.test(String(value||'').trim());}
function allowedEmailDeliverability_(status){return ['DELIVERABLE','UNDELIVERABLE','CATCH_ALL','UNKNOWN','UNVERIFIED'].indexOf(status)>=0?status:'UNVERIFIED';}
function allowedPhoneActivity_(status){return ['ACTIVE','INACTIVE','UNKNOWN','UNVERIFIED'].indexOf(status)>=0?status:'UNVERIFIED';}
function aggregateMxStatus_(emails,lookupMx,mxByDomain){
  if(!emails.length)return 'MISSING';
  if(!lookupMx)return 'UNKNOWN';
  var statuses=emails.map(function(email){var domain=String(email).split('@').pop().toLowerCase();if(!Object.prototype.hasOwnProperty.call(mxByDomain,domain))mxByDomain[domain]=lookupEmailMx_(domain);return mxByDomain[domain];});
  if(statuses.indexOf('NO_MX')>=0)return 'NO_MX';
  if(statuses.every(function(status){return status==='MX_PRESENT';}))return 'MX_PRESENT';
  return 'UNKNOWN';
}

/** Public DNS-over-HTTPS MX lookup. Does not test mailbox delivery. */
function lookupEmailMx_(domain) {
  try {
    var response=UrlFetchApp.fetch('https://dns.google/resolve?name='+encodeURIComponent(domain)+'&type=MX',{muteHttpExceptions:true});
    if(response.getResponseCode()<200||response.getResponseCode()>=300)return 'UNKNOWN';
    var body=JSON.parse(response.getContentText());
    if(Number(body.Status)===3)return 'NO_MX';
    if(Number(body.Status)!==0)return 'UNKNOWN';
    return (body.Answer||[]).some(function(answer){return Number(answer.type)===15;})?'MX_PRESENT':'NO_MX';
  } catch(error) { return 'UNKNOWN'; }
}

/** Optional generic verifier adapter. Disabled unless endpoint and token Script Properties are deliberately configured. */
function verifyEmailWithConfiguredProvider_(email) {
  var result=callConfiguredVerifier_('EMAIL_VERIFIER_API_URL','EMAIL_VERIFIER_API_TOKEN',{email:String(email||'')});
  if(!result)return 'UNVERIFIED';
  var value=String(result.status||result.result||'').toLowerCase();
  if(value==='deliverable')return 'DELIVERABLE';
  if(value==='undeliverable')return 'UNDELIVERABLE';
  if(value==='catch_all'||value==='catch-all')return 'CATCH_ALL';
  return 'UNKNOWN';
}
function verifyPhoneWithConfiguredProvider_(phone) {
  var normalized=validatePhone(phone);
  if(normalized.status!=='FORMAT_VALID')return 'UNVERIFIED';
  var result=callConfiguredVerifier_('PHONE_VERIFIER_API_URL','PHONE_VERIFIER_API_TOKEN',{phone:normalized.value});
  if(!result)return 'UNVERIFIED';
  var value=String(result.status||result.result||'').toLowerCase();
  if(value==='active')return 'ACTIVE';
  if(value==='inactive'||value==='disconnected')return 'INACTIVE';
  return 'UNKNOWN';
}
function callConfiguredVerifier_(urlProperty,tokenProperty,payload) {
  try {
    var properties=PropertiesService.getScriptProperties();
    var endpoint=String(properties.getProperty(urlProperty)||'').trim();
    var token=String(properties.getProperty(tokenProperty)||'').trim();
    if(!endpoint||!token||!validHttpSource_(endpoint))return null;
    var response=UrlFetchApp.fetch(endpoint,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+token},payload:JSON.stringify(payload),muteHttpExceptions:true});
    if(response.getResponseCode()<200||response.getResponseCode()>=300)return {status:'UNKNOWN'};
    return JSON.parse(response.getContentText());
  } catch(error) { return {status:'UNKNOWN'}; }
}
