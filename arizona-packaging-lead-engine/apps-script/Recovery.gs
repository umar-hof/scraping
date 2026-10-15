function saveCheckpoint(data){PropertiesService.getScriptProperties().setProperty('PE_CHECKPOINT',JSON.stringify(data||{}));return true;}
function restoreCheckpoint(){var raw=PropertiesService.getScriptProperties().getProperty('PE_CHECKPOINT');return raw?JSON.parse(raw):{};}
function retryCandidate_(row,error){var sh=getSpreadsheet_().getSheetByName('Review Queue'); var note=String(sh.getRange(row,7).getValue()||''); var m=/retries=(\d+)/.exec(note), n=m?Number(m[1])+1:1; if(n>Number(getSetting_('Maximum Retries')||3))markQueue_(row,'FAILED',error+' retries='+n); else markQueue_(row,'RETRY_WAIT',error+' retries='+n);}

