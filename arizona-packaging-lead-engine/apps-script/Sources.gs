function parseCandidateCsv_(csvText,sourceLabel){
  if(!csvText)throw Error('CSV text is required');
  var rows=Utilities.parseCsv(csvText);if(!rows.length)return [];
  var headers=rows.shift().map(String),idx={};headers.forEach(function(h,i){idx[h.toLowerCase().trim()]=i;});
  ['company name','website','city'].forEach(function(h){if(idx[h]===undefined)throw Error('CSV must contain '+h);});
  function cell(row,name){return idx[name]===undefined?'':String(row[idx[name]]||'').trim();}
  var candidates=[];
  rows.forEach(function(row){
    if(!row.join('').trim())return;
    candidates.push({companyName:cell(row,'company name'),website:cell(row,'website'),city:cell(row,'city'),address:cell(row,'address'),industry:cell(row,'industry'),
      sourceUrl:cell(row,'source url')||sourceLabel||'CSV_USER_IMPORT',companyPhone:cell(row,'company phone'),employeeSize:cell(row,'employee size'),brandEvidence:cell(row,'brand evidence'),
      locationEvidenceUrl:cell(row,'arizona evidence url'),productEvidenceUrl:cell(row,'product evidence url'),physicalProductsEvidence:cell(row,'physical products evidence'),
      evidenceReviewed:cell(row,'evidence reviewed').toUpperCase()==='YES',sourceId:cell(row,'source id'),contactSourceUrl:cell(row,'contact source url'),email:cell(row,'poc email id'),emailSourceUrl:cell(row,'email source url'),
      pocName:cell(row,'poc name'),designation:cell(row,'designation'),department:cell(row,'department'),pocPhone:cell(row,'poc contact number'),phoneSourceUrl:cell(row,'phone source url'),linkedin:cell(row,'li poc profile'),
      packagingOpportunity:cell(row,'packaging opportunity'),notes:cell(row,'notes')});
  });
  return candidates;
}
function importCandidatesCsv(csvText,sourceLabel){var candidates=parseCandidateCsv_(csvText,sourceLabel),count=0;candidates.forEach(function(c){if(enqueueCandidate_(c))count++;});return count;}
function previewCandidatesCsv(csvText,sourceLabel){
  var candidates=parseCandidateCsv_(csvText,sourceLabel),seen=[],results=[],summary={input:candidates.length,qualified:0,needsReview:0,duplicatesInFile:0,duplicatesInProspects:0};
  candidates.forEach(function(c){
    var duplicateInFile=seen.some(function(prev){return sameCompany_(prev,c);});
    var assessment=qualifyPilotCandidate_(c),duplicateInProspects=checkDuplicate(c);
    var status=duplicateInFile?'DUPLICATE_IN_FILE':duplicateInProspects.duplicate?'DUPLICATE_IN_PROSPECTS':assessment.qualified?'WOULD_QUEUE':'NEEDS_REVIEW';
    if(!duplicateInFile)seen.push(c);
    if(status==='WOULD_QUEUE')summary.qualified++;
    else if(status==='NEEDS_REVIEW')summary.needsReview++;
    else if(status==='DUPLICATE_IN_FILE')summary.duplicatesInFile++;
    else summary.duplicatesInProspects++;
    results.push({company:c.companyName,status:status,score:assessment.score.score,reasons:assessment.reasons,duplicateReason:duplicateInProspects.reason||'',sourceUrl:c.sourceUrl});
  });
  Logger.log('CSV_PREVIEW '+JSON.stringify(summary));
  return {dryRun:true,summary:summary,candidates:results};
}
function seedCandidate_(candidate){return enqueueCandidate_(candidate);}
function enqueueCandidate_(c){
  var sh=getSpreadsheet_().getSheetByName('Review Queue');
  var id=stableId_(normalizeDomain(c.website)||normalizeCompanyName_(c.companyName)+'|'+normalizeCompanyName_(c.city));
  var rows=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,7).getValues():[];
  if(rows.some(function(r){if(r[1]===id)return true;try{return sameCompany_(JSON.parse(r[6]||'{}'),c);}catch(e){return false;}}))return false;
  if(typeof checkDuplicate==='function'&&checkDuplicate(c).duplicate)return false;
  sh.appendRow([Utilities.getUuid(),id,'PENDING_RESEARCH',c.sourceUrl||'CSV_USER_IMPORT','PENDING',now_(),JSON.stringify(c)]);return true;
}
function discoverCandidates(){var sh=getSpreadsheet_().getSheetByName('Review Queue');return Math.max(0,sh.getLastRow()-1);}
function discoverFromCsv_(csvText){return importCandidatesCsv(csvText,'CSV_USER_IMPORT');}
function discoverCandidatesFromApprovedCsv(csvText){return discoverFromCsv_(csvText);}
function normalizeCompanyName_(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function sameCompany_(a,b){var da=normalizeDomain(a.website),db=normalizeDomain(b.website);if(da&&db&&da===db)return true;return normalizeCompanyName_(a.companyName)===normalizeCompanyName_(b.companyName)&&normalizeCompanyName_(a.city)===normalizeCompanyName_(b.city);}
function hasHttpUrl_(value){return /^https?:\/\//i.test(String(value||''));}
function qualifyPilotCandidate_(c){
  var reasons=[];
  if(!c||!c.companyName)reasons.push('missing company name');
  if(!hasHttpUrl_(c&&c.website))reasons.push('missing official website URL');
  if(!isArizona(c&&c.city,c&&c.address))reasons.push('Arizona location not evidenced');
  if(!hasHttpUrl_(c&&c.sourceUrl))reasons.push('missing discovery source URL');
  if(!hasHttpUrl_(c&&c.locationEvidenceUrl))reasons.push('missing official Arizona-location evidence URL');
  if(!hasHttpUrl_(c&&c.productEvidenceUrl))reasons.push('missing official physical-product evidence URL');
  if(!String(c&&c.brandEvidence||'').trim()||!String(c&&c.physicalProductsEvidence||'').trim())reasons.push('missing physical-product/brand evidence');
  if(!c||c.evidenceReviewed!==true)reasons.push('official-site evidence has not been manually reviewed');
  var score=calculateICPScore(c||{}),minimum=Number(getSetting_('Minimum ICP Score'))||60;
  if(score.score<minimum)reasons.push('ICP score '+score.score+' below minimum '+minimum);
  return {qualified:reasons.length===0,reasons:reasons,score:score};
}
