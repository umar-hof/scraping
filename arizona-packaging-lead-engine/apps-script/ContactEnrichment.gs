/** Contact enrichment preview and explicit update-by-Lead-ID path. */
var CONTACT_ENRICHMENT_HEADERS_ = [
  'Lead ID','Company Name','Company Contact Email','Company Email Source URL',
  'Company Phone','Company Phone Source URL','POC Name','POC Title','Department',
  'POC Email','POC Email Source URL','POC Phone','POC Phone Source URL',
  'LinkedIn POC URL','LinkedIn Source URL','Contact Source URL','Evidence Reviewed','Notes'
];

function previewContactEnrichmentCsv(csvText) {
  return contactEnrichmentPlan_(csvText);
}

/** Reads the separately staged contact CSV; does not alter PILOT_CSV_FILE_ID. */
function previewArizonaContactEnrichment() {
  var result = previewContactEnrichmentCsv(readContactEnrichmentCsvText_());
  Logger.log('CONTACT_ENRICHMENT_PREVIEW ' + JSON.stringify(result.summary));
  return result;
}

/** Explicit manual write entry point. Do not run before approving the preview. */
function updateArizonaContactsFromDriveCsv() {
  return updateExistingProspectsContactsCsv(readContactEnrichmentCsvText_());
}

function readContactEnrichmentCsvText_() {
  var fileId = String(PropertiesService.getScriptProperties().getProperty('CONTACT_ENRICHMENT_CSV_FILE_ID') || '').trim();
  if (!fileId) throw new Error('Set CONTACT_ENRICHMENT_CSV_FILE_ID to the Drive-hosted contact-enrichment CSV ID.');
  var file = DriveApp.getFileById(fileId);
  var name = String(file.getName() || '');
  var mimeType = String(file.getMimeType() || '').toLowerCase();
  if (!/\.csv$/i.test(name) && mimeType !== 'text/csv' && mimeType !== 'application/vnd.ms-excel') throw new Error('CONTACT_ENRICHMENT_CSV_FILE_ID must identify a CSV file.');
  return file.getBlob().getDataAsString('UTF-8');
}

/** Manual-only write function. Not run as part of previews or tests against live data. */
function updateExistingProspectsContactsCsv(csvText) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var plan = contactEnrichmentPlan_(csvText);
    var sheet = getSpreadsheet_().getSheetByName('Prospects');
    var headers = sheet.getRange(1, 1, 1, 26).getValues()[0];
    if (headers.join('\u001f') !== PE.TAB_HEADERS.Prospects.join('\u001f')) throw new Error('Prospects headers do not match the 26-column schema; no updates made.');
    var rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 26).getValues();
    var summary = {input:plan.summary.input, updated:0, fieldsUpdated:0, fieldsPreserved:0, skipped:0, rejected:plan.summary.rejected, failed:0};
    plan.records.forEach(function(item) {
      if (!item.valid) { summary.rejected++; return; }
      try {
        var matches = [];
        rows.forEach(function(row, i) { if (String(row[24] || '').trim() === item.values['Lead ID']) matches.push({row:row,index:i}); });
        if (matches.length !== 1 || matches[0].row[0] !== item.values['Company Name']) { summary.rejected++; return; }
        var row = matches[0].row, sheetRow = matches[0].index + 2, changes = [];
        var duplicateContact = rows.some(function(other, i) {
          if (i === matches[0].index) return false;
          var email = item.values['POC Email'] && String(other[4] || '').trim().toLowerCase() === item.values['POC Email'].toLowerCase();
          var phoneDigits = String(item.values['POC Phone'] || '').replace(/\D/g,'');
          var otherPhoneDigits = String(other[2] || '').replace(/\D/g,'');
          var phone = phoneDigits && otherPhoneDigits && phoneDigits === otherPhoneDigits;
          return email || phone;
        });
        if (duplicateContact) { summary.rejected++; return; }
        function addIfBlank(col, key) {
          var value = item.values[key];
          if (value && !String(row[col] || '').trim()) changes.push({col:col + 1,value:value});
          else if (value) summary.fieldsPreserved++;
        }
        addIfBlank(1,'POC Title'); addIfBlank(2,'POC Phone'); addIfBlank(3,'Company Phone');
        addIfBlank(4,'POC Email'); addIfBlank(5,'Department'); addIfBlank(7,'LinkedIn POC URL'); addIfBlank(8,'POC Name');
        var hasPocEmail = !!item.values['POC Email'], hasPocPhone = !!item.values['POC Phone'];
        if (hasPocEmail && !String(row[4] || '').trim() && !String(row[19] || '').trim()) changes.push({col:20,value:'SOURCE_LISTED'});
        if (hasPocPhone && !String(row[2] || '').trim() && !String(row[20] || '').trim()) changes.push({col:21,value:'SOURCE_LISTED'});
        var sourceUrls = [item.values['Company Email Source URL'],item.values['Company Phone Source URL'],item.values['POC Email Source URL'],item.values['POC Phone Source URL'],item.values['LinkedIn Source URL'],item.values['Contact Source URL']].filter(Boolean);
        if (sourceUrls.length) {
          var existingSources = String(row[18] || '').split(/\s*\|\s*/).filter(Boolean);
          sourceUrls.forEach(function(url) { if (existingSources.indexOf(url) < 0) existingSources.push(url); });
          var joined = existingSources.join(' | ');
          if (joined !== String(row[18] || '')) changes.push({col:19,value:joined});
        }
        var noteParts = [];
        if (item.values['Company Contact Email']) noteParts.push('Public company email (SOURCE_LISTED; mailbox activity not independently verified): ' + item.values['Company Contact Email'] + ' — ' + item.values['Company Email Source URL']);
        if (item.values.Notes) noteParts.push(item.values.Notes);
        if (noteParts.length) {
          var oldNotes = String(row[25] || '');
          var toAdd = noteParts.filter(function(note) { return oldNotes.indexOf(note) < 0; });
          if (toAdd.length) changes.push({col:26,value:[oldNotes].concat(toAdd).filter(Boolean).join(' | ')});
        }
        if (!changes.length) { summary.skipped++; return; }
        changes.forEach(function(change) { sheet.getRange(sheetRow,change.col).setValue(change.value); row[change.col - 1] = change.value; summary.fieldsUpdated++; });
        summary.updated++;
      } catch (error) { summary.failed++; Logger.log('CONTACT_ENRICHMENT_ROW_ERROR ' + JSON.stringify({leadId:item.values['Lead ID'],error:String(error && error.message || error)})); }
    });
    Logger.log('CONTACT_ENRICHMENT_UPDATE ' + JSON.stringify(summary));
    return {dryRun:false,summary:summary};
  } finally { lock.releaseLock(); }
}

function contactEnrichmentPlan_(csvText) {
  var parsed = Utilities.parseCsv(String(csvText || ''));
  if (!parsed || parsed.length < 1) throw new Error('Contact enrichment CSV is empty.');
  if (parsed[0].join('\u001f') !== CONTACT_ENRICHMENT_HEADERS_.join('\u001f')) throw new Error('Contact enrichment CSV headers are missing or out of order.');
  var sheet = getSpreadsheet_().getSheetByName('Prospects');
  if (!sheet) throw new Error('Prospects sheet is missing.');
  if (sheet.getRange(1,1,1,26).getValues()[0].join('\u001f') !== PE.TAB_HEADERS.Prospects.join('\u001f')) throw new Error('Prospects headers do not match the 26-column schema.');
  var live = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,1,sheet.getLastRow()-1,26).getValues();
  var seen = {}, seenPocEmails = {}, seenPocPhones = {}, records = [], summary = {input:parsed.length-1,matched:0,ready:0,rejected:0,fieldsAvailable:0};
  parsed.slice(1).forEach(function(row) {
    var values = {}; CONTACT_ENRICHMENT_HEADERS_.forEach(function(key,i) { values[key] = String(row[i] || '').trim(); });
    var errors = [];
    if (!values['Lead ID'] || seen[values['Lead ID']]) errors.push('missing or duplicate Lead ID in CSV');
    seen[values['Lead ID']] = true;
    if (values['Evidence Reviewed'] !== 'YES') errors.push('evidence review not affirmed');
    var matches = live.filter(function(r) { return String(r[24] || '').trim() === values['Lead ID']; });
    if (matches.length !== 1) errors.push('Lead ID must match exactly one existing Prospects row');
    else if (String(matches[0][0] || '').trim() !== values['Company Name']) errors.push('company name does not match Lead ID');
    [ ['Company Contact Email','Company Email Source URL'],['Company Phone','Company Phone Source URL'],['POC Email','POC Email Source URL'],['POC Phone','POC Phone Source URL'],['POC Name','Contact Source URL'],['POC Title','Contact Source URL'],['Department','Contact Source URL'],['LinkedIn POC URL','LinkedIn Source URL'] ].forEach(function(pair) {
      if (values[pair[0]] && !/^https?:\/\//i.test(values[pair[1]])) errors.push(pair[0] + ' lacks an HTTP(S) evidence URL');
    });
    if (values['POC Email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['POC Email'])) errors.push('POC Email format invalid');
    if (values['Company Contact Email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['Company Contact Email'])) errors.push('Company Contact Email format invalid');
    var emailKey = values['POC Email'].toLowerCase();
    var phoneKey = values['POC Phone'].replace(/\D/g,'');
    if (emailKey && seenPocEmails[emailKey]) errors.push('duplicate POC email in CSV');
    if (phoneKey && seenPocPhones[phoneKey]) errors.push('duplicate POC phone in CSV');
    if (emailKey) seenPocEmails[emailKey] = true;
    if (phoneKey) seenPocPhones[phoneKey] = true;
    if (values['LinkedIn POC URL'] && !/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(values['LinkedIn POC URL'])) errors.push('LinkedIn POC URL must be an independently sourced public profile URL');
    ['Company Email Source URL','Company Phone Source URL','POC Email Source URL','POC Phone Source URL','LinkedIn Source URL','Contact Source URL'].forEach(function(key) {
      if (values[key] && !/^https?:\/\//i.test(values[key])) errors.push(key + ' must be an HTTP(S) URL');
    });
    if (errors.length) { summary.rejected++; records.push({values:values,valid:false,errors:errors}); return; }
    summary.matched++;
    var fields = ['Company Contact Email','Company Phone','POC Name','POC Title','Department','POC Email','POC Phone','LinkedIn POC URL'];
    var count = fields.filter(function(key) { return !!values[key]; }).length;
    summary.fieldsAvailable += count;
    if (count) summary.ready++;
    records.push({values:values,valid:true});
  });
  return {dryRun:true,summary:summary,records:records};
}
