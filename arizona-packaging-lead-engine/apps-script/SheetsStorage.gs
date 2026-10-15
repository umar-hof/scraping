function appendProspects(records){
  if(!records||!records.length)return 0;
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    var ss=getSpreadsheet_(),sh=ss.getSheetByName('Prospects'),notes=ss.getSheetByName('ICP Notes'),added=0;
    records.forEach(function(r){
      var qualification=qualifyPilotCandidate_(r);
      if(!qualification.qualified)throw new Error('Refusing to append unqualified candidate: '+qualification.reasons.join('; '));
      if(checkDuplicate(r).duplicate)return;
      var email=validateEmail(r.email),phone=validatePhone(r.pocPhone),score=qualification.score;
      var emailSource=hasHttpUrl_(r.emailSourceUrl)?r.emailSourceUrl:(hasHttpUrl_(r.contactSourceUrl)?r.contactSourceUrl:'');
      var phoneSource=hasHttpUrl_(r.phoneSourceUrl)?r.phoneSourceUrl:(hasHttpUrl_(r.contactSourceUrl)?r.contactSourceUrl:'');
      var publicEmail=emailSource&&email.status==='FORMAT_VALID'?email.value:'';
      var publicPhone=phoneSource&&phone.status==='FORMAT_VALID'?phone.value:'';
      var publicContact=hasHttpUrl_(r.contactSourceUrl);
      var emailStatus=email.status==='INVALID'&&r.email?'INVALID':publicEmail?'SOURCE_LISTED':'UNVERIFIED';
      var phoneStatus=phone.status==='INVALID'&&r.pocPhone?'INVALID':publicPhone?'SOURCE_LISTED':'UNVERIFIED';
      var contactNotes=['Email format '+(email.status==='FORMAT_VALID'?'valid':'not checked')+'; mailbox activity not independently verified','Phone format '+(phone.status==='FORMAT_VALID'?'valid':'not checked')+'; number not independently verified'];
      if(publicEmail)contactNotes.push('Email publicly listed at: '+emailSource);
      if(publicPhone)contactNotes.push('Phone publicly listed at: '+phoneSource);
      var contactSource=hasHttpUrl_(r.contactSourceUrl)?r.contactSourceUrl:[emailSource,phoneSource].filter(Boolean).join(' | ');
      var evidenceNotes=[];
      if(r.notes)evidenceNotes.push(r.notes);
      if(r.locationEvidenceUrl)evidenceNotes.push('Arizona location evidence: '+r.locationEvidenceUrl);
      if(r.productEvidenceUrl)evidenceNotes.push('Physical product evidence: '+r.productEvidenceUrl);
      if(r.sourceId)evidenceNotes.push('Source ID: '+r.sourceId);
      var row=[r.companyName||'',publicContact?(r.designation||''):'',publicPhone||'',r.companyPhone||'',publicEmail||'',publicContact?(r.department||''):'',r.employeeSize||'UNKNOWN',publicContact?(r.linkedin||''):'',publicContact?(r.pocName||''):'',r.website||'',normalizeDomain(r.website||''),r.city||'',r.address||'',r.industry||'',score.score,r.brandEvidence||'',r.packagingOpportunity||'',r.sourceUrl||'',contactSource,emailStatus,phoneStatus,r.researchStatus||'QUALIFIED',now_(),now_(),stableId_((r.website||r.companyName)+'|'+(publicEmail|| (publicContact?r.pocName:'')||'')),evidenceNotes.concat(contactNotes).filter(Boolean).join(' | ')];
      if(row.length!==PE.TAB_HEADERS.Prospects.length)throw new Error('Prospects row width mismatch; expected 26 columns.');
      sh.appendRow(row);notes.appendRow([row[24],score.score,score.category,score.explanation,score.evidence.join(' | '),now_()]);added++;
    });
    return added;
  }finally{lock.releaseLock();}
}
function getProspects_(){var sh=getSpreadsheet_().getSheetByName('Prospects');return sh.getLastRow()<2?[]:sh.getDataRange().getValues().slice(1);}
