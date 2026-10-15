/**
 * Read-only pilot preview. Configure Script Property PILOT_CSV_FILE_ID with
 * the ID of the staged CSV file in Drive before running this function.
 */
function previewArizonaPilot() {
  var csvText = readArizonaPilotCsvText_();
  return previewCandidatesCsv(csvText, 'MANUAL_OFFICIAL_WEB_REVIEW');
}

function readArizonaPilotCsvText_() {
  var fileId = String(PropertiesService.getScriptProperties().getProperty('PILOT_CSV_FILE_ID') || '').trim();
  if (!fileId) throw new Error('Set the PILOT_CSV_FILE_ID script property to the Drive-hosted pilot CSV file ID.');

  var file = DriveApp.getFileById(fileId);
  var name = String(file.getName() || '');
  var mimeType = String(file.getMimeType() || '').toLowerCase();
  if (!/\.csv$/i.test(name) && mimeType !== 'text/csv' && mimeType !== 'application/vnd.ms-excel') {
    throw new Error('PILOT_CSV_FILE_ID must identify a CSV file.');
  }

  return file.getBlob().getDataAsString('UTF-8');
}

/**
 * Explicit, manual write path for the reviewed Arizona pilot. Does not create
 * tabs or headers; it validates the existing Prospects schema before appending.
 */
function importApprovedArizonaPilot() {
  var startedAt = Date.now();
  var summary = {input:0,qualified:0,imported:0,skipped:0,rejected:0,failed:0};
  var candidates;
  try {
    candidates = parseCandidateCsv_(readArizonaPilotCsvText_(), 'MANUAL_OFFICIAL_WEB_REVIEW');
    summary.input = candidates.length;
    var ss = getSpreadsheet_();
    var prospects = ss.getSheetByName('Prospects');
    if (!prospects || !ss.getSheetByName('ICP Notes') || !ss.getSheetByName('Run Logs')) {
      throw new Error('Required existing Prospects, ICP Notes, or Run Logs tab is missing; no tabs were created.');
    }
    var headers = prospects.getRange(1, 1, 1, PE.TAB_HEADERS.Prospects.length).getValues()[0];
    if (headers.join('\u001f') !== PE.TAB_HEADERS.Prospects.join('\u001f')) {
      throw new Error('Prospects headers do not match the configured 26-column schema; refusing import.');
    }
  } catch (error) {
    summary.failed++;
    summary.error = String(error && error.message || error);
    Logger.log('ARIZONA_PILOT_IMPORT ' + JSON.stringify(summary));
    throw error;
  }

  var seen = [];
  candidates.forEach(function(candidate) {
    try {
      var duplicateInFile = seen.some(function(previous) {
        var sameContact = candidate.email && previous.email && String(candidate.email).toLowerCase() === String(previous.email).toLowerCase();
        var samePhone = candidate.pocPhone && previous.pocPhone && normalizePhoneForDedupe_(candidate.pocPhone) === normalizePhoneForDedupe_(previous.pocPhone);
        return sameCompany_(previous, candidate) || sameContact || samePhone;
      });
      if (duplicateInFile) { summary.skipped++; return; }
      seen.push(candidate);

      var assessment = qualifyPilotCandidate_(candidate);
      var rejectionReasons = assessment.reasons.slice();
      if (candidate.sourceId !== 'MANUAL_OFFICIAL_WEB_REVIEW') rejectionReasons.push('unsupported or missing source ID');
      if (!String(candidate.industry || '').trim()) rejectionReasons.push('missing industry');
      if ((candidate.pocName || candidate.designation || candidate.department || candidate.linkedin) && !hasHttpUrl_(candidate.contactSourceUrl)) rejectionReasons.push('POC details lack a public contact source URL');
      if (candidate.email && !hasHttpUrl_(candidate.emailSourceUrl) && !hasHttpUrl_(candidate.contactSourceUrl)) rejectionReasons.push('email lacks a public source URL');
      if (candidate.pocPhone && !hasHttpUrl_(candidate.phoneSourceUrl) && !hasHttpUrl_(candidate.contactSourceUrl)) rejectionReasons.push('POC phone lacks a public source URL');
      if (rejectionReasons.length) {
        summary.rejected++;
        Logger.log('ARIZONA_PILOT_REJECTED ' + JSON.stringify({company:candidate.companyName,reasons:rejectionReasons}));
        return;
      }
      summary.qualified++;

      // Check current Prospects immediately before append. appendProspects checks again
      // while holding the script lock, protecting against concurrent/rerun duplicates.
      if (checkDuplicate(candidate).duplicate) { summary.skipped++; return; }
      if (appendProspects([candidate])) summary.imported++;
      else summary.skipped++;
    } catch (error) {
      summary.failed++;
      Logger.log('ARIZONA_PILOT_CANDIDATE_ERROR ' + JSON.stringify({company:candidate.companyName,error:String(error && error.message || error)}));
    }
  });

  var status = 'ARIZONA_PILOT_IMPORT imported=' + summary.imported + ' skipped=' + summary.skipped + ' rejected=' + summary.rejected + ' failed=' + summary.failed;
  try {
    writeRunLog_('AZPILOT-' + startedAt, startedAt, {
      discovered:summary.input,researched:summary.input,qualified:summary.qualified,
      pocs:0,emails:0,phones:0,added:summary.imported,duplicates:summary.skipped,errors:summary.failed
    }, status);
  } catch (logError) {
    summary.runLogError = String(logError && logError.message || logError);
  }
  Logger.log('ARIZONA_PILOT_IMPORT ' + JSON.stringify(summary));
  return {dryRun:false,summary:summary};
}
