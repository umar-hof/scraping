function installHourlyTrigger(){removeAutomationTriggers(); ScriptApp.newTrigger('runLeadAutomation').timeBased().everyHours(1).create(); return true;}
function removeAutomationTriggers(){ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='runLeadAutomation')ScriptApp.deleteTrigger(t);});}
function runLeadAutomation(){if(String(getSetting_('Automation Enabled')).toUpperCase()!=='TRUE'&&getSetting_('Automation Enabled')!==true)return {status:'DISABLED'}; var start=Date.now(), runId=Utilities.getUuid(), stats={discovered:0,researched:0,qualified:0,pocs:0,emails:0,phones:0,added:0,duplicates:0,errors:0}; var lock=LockService.getScriptLock(); if(!lock.tryLock(1000))return {status:'LOCKED'}; try {var candidates=loadPendingCandidates_(Number(getSetting_('Batch Size'))||25);stats.discovered=candidates.length; candidates.forEach(function(c){if(Date.now()-start>Number(getSetting_('Maximum Execution Time')||300000)-5000)return; markQueue_(c._queueRow,'RESEARCHING'); var r=researchCompany(c);stats.researched++; if(r.status!=='OK'){markQueue_(c._queueRow,r.status==='RETRY_WAIT'?'RETRY_WAIT':'NEEDS_REVIEW',r.reason);stats.errors++;return;} var contact=researchDecisionMakers(c), record=Object.assign({},c,r,contact,{department:departmentForTitle_(contact.designation),researchStatus:'QUALIFIED'}); var result=appendProspects([record]);stats.added+=result;stats.qualified+=result; if(contact.pocName)stats.pocs++; if(contact.email)stats.emails++; if(contact.pocPhone)stats.phones++; markQueue_(c._queueRow,'COMPLETED');}); saveCheckpoint({lastRun:now_(),runId:runId}); writeRunLog_(runId,start,stats,'OK'); if(getSetting_('Daily Summary Enabled')===true||String(getSetting_('Daily Summary Enabled')).toUpperCase()==='TRUE')generateDailySummary(); return stats;}catch(e){stats.errors++;writeRunLog_(runId,start,stats,'ERROR: '+e);throw e;}finally{lock.releaseLock();}}
function runPilot(options){
  options=options||{};var dryRun=options.dryRun!==false;
  if(!dryRun&&options.confirmWrite!==true)throw new Error('Writes require runPilot({dryRun:false, confirmWrite:true}).');
  var start=Date.now(),runId=Utilities.getUuid(),stats={discovered:0,researched:0,qualified:0,pocs:0,emails:0,phones:0,added:0,duplicates:0,errors:0},out=[];
  try{
    var candidates=loadPendingCandidates_(20);stats.discovered=candidates.length;
    candidates.forEach(function(c){
      try{
        var result=researchCompany(c);stats.researched++;
        if(result.status!=='OK'){out.push({company:c.companyName,status:'NEEDS_REVIEW',reason:result.reason||''});if(!dryRun)markQueue_(c._queueRow,'NEEDS_REVIEW',result.reason||'Evidence/qualification requirement failed');return;}
        var contact=researchDecisionMakers(c),record=Object.assign({},c,result,contact,{department:c.department||departmentForTitle_(contact.designation),researchStatus:'QUALIFIED'}),dup=checkDuplicate(record);
        if(dup.duplicate){stats.duplicates++;out.push({company:c.companyName,status:'DUPLICATE',reason:dup.reason});if(!dryRun)markQueue_(c._queueRow,'COMPLETED','Duplicate skipped: '+dup.reason);return;}
        stats.qualified++;if(contact.pocName)stats.pocs++;if(contact.email)stats.emails++;if(contact.pocPhone)stats.phones++;
        if(!dryRun){stats.added+=appendProspects([record]);markQueue_(c._queueRow,'COMPLETED','Appended by approved pilot run.');}
        out.push({company:c.companyName,status:dryRun?'WOULD_APPEND':'APPENDED',icpScore:result.icpScore,sourceUrl:c.sourceUrl});
      }catch(error){stats.errors++;out.push({company:c.companyName,status:'ERROR',reason:safeErrorMessage_(error)});if(!dryRun)markQueue_(c._queueRow,'NEEDS_REVIEW','Pilot error; see Run Logs.');}
    });
    stats.durationMs=Date.now()-start;stats.status=dryRun?'DRY_RUN':'PILOT_COMPLETE';if(!dryRun)writeRunLog_(runId,start,stats,stats.status);
    Logger.log('PILOT_'+stats.status+' '+JSON.stringify({runId:runId,stats:stats,candidates:out}));return {runId:runId,status:stats.status,dryRun:dryRun,stats:stats,candidates:out};
  }catch(error){stats.errors++;stats.durationMs=Date.now()-start;if(!dryRun){try{writeRunLog_(runId,start,stats,'ERROR');}catch(logError){Logger.log('PILOT_LOG_FAILURE '+safeErrorMessage_(logError));}}Logger.log('PILOT_ERROR '+safeErrorMessage_(error));throw error;}
}
function safeErrorMessage_(error){return String(error&&error.message?error.message:error).replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/ig,'$1=[REDACTED]').slice(0,500);}

