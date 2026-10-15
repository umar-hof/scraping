function setupSystem() {
  var ss = getSpreadsheet_();
  initializeSheets();
  seedApprovedSources();
  ss.setActiveSheet(ss.getSheetByName('Prospects'));
  var diagnostic = diagnoseSpreadsheet();
  if (diagnostic.setupStatus !== 'READY') throw new Error('Spreadsheet setup did not validate: ' + diagnostic.setupStatus);
  Logger.log('setupSystem completed: ' + JSON.stringify(diagnostic));
  return {ok: true, version: PE.VERSION, diagnostic: diagnostic};
}

function initializeSheets() {
  var ss = getSpreadsheet_();
  PE.TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    ensureHeaders_(sh, PE.TAB_HEADERS[name]);
  });
  ensureContactVerificationColumns_();
  var settings = ss.getSheetByName('Settings');
  var current = settings.getLastRow() > 1 ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getValues() : [];
  var existing = {};
  current.forEach(function(row) { if (row[0] !== '') existing[String(row[0])] = true; });
  Object.keys(PE.SETTINGS_DEFAULTS).forEach(function(key) {
    if (!existing[key]) settings.appendRow([key, PE.SETTINGS_DEFAULTS[key], 'Configured by setupSystem']);
  });
  return true;
}

/** Append-only schema extension; never shifts or rewrites the legacy 26 columns. */
function ensureContactVerificationColumns() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return ensureContactVerificationColumns_(); }
  finally { lock.releaseLock(); }
}

function ensureContactVerificationColumns_() {
  var sheet = getSpreadsheet_().getSheetByName('Prospects');
  if (!sheet) throw new Error('Prospects tab is missing; no verification columns were added.');
  var baseWidth = PE.PROSPECTS_LEGACY_WIDTH;
  var base = sheet.getRange(1,1,1,baseWidth).getDisplayValues()[0];
  if (base.join('\u001f') !== PE.TAB_HEADERS.Prospects.join('\u001f')) throw new Error('Legacy Prospects headers do not match; refusing to add verification columns.');
  var lastColumn = sheet.getLastColumn();
  var extensionWidth = PE.PROSPECTS_VERIFICATION_HEADERS.length;
  if (lastColumn === baseWidth) {
    sheet.getRange(1,baseWidth+1,1,extensionWidth).setValues([PE.PROSPECTS_VERIFICATION_HEADERS]);
    return {added:true,headers:extensionWidth};
  }
  if (lastColumn === baseWidth+extensionWidth) {
    var current = sheet.getRange(1,baseWidth+1,1,extensionWidth).getDisplayValues()[0];
    if (current.join('\u001f') === PE.PROSPECTS_VERIFICATION_HEADERS.join('\u001f')) return {added:false,headers:extensionWidth};
  }
  throw new Error('Unexpected content after legacy Prospects columns; refusing to shift, overwrite, or append headers.');
}

function ensureHeaders_(sh, headers) {
  if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var existing = sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    var matches = headers.every(function(header, index) { return existing[index] === header; });
    if (!matches) {
      throw new Error('Header mismatch in tab "' + sh.getName() + '". Existing cells were preserved; expected: ' + headers.join(' | '));
    }
  }
  sh.setFrozenRows(1);
}

function seedApprovedSources() {
  var sh = getSpreadsheet_().getSheetByName('Source Registry');
  var values = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
  var existing = {};
  values.forEach(function(row) { if (row[0] !== '') existing[String(row[0])] = true; });
  if (!existing.CSV_USER_IMPORT) sh.appendRow(['CSV_USER_IMPORT','Approved user-provided CSV','User upload / Drive file','CSV','USER_APPROVED','','','0','','TRUE']);
  if (!existing.MANUAL_OFFICIAL_WEB_REVIEW) sh.appendRow(['MANUAL_OFFICIAL_WEB_REVIEW','Official company-site manual review','Candidate-specific official URL','MANUAL_RESEARCH','PUBLIC_PAGE_MANUAL_REVIEW_ONLY','','','','','TRUE']);
  if (!existing.OSM_OVERPASS_PILOT) sh.appendRow(['OSM_OVERPASS_PILOT','OSM Overpass one-time Arizona pilot','https://overpass-api.de/api/interpreter','ONE_TIME_QUERY','ONE_TIME_ONLY; QUERY_NOT_COMPLETED','','','','','FALSE']);
}

function diagnoseSpreadsheet() {
  var result = {name: '', id: '', url: '', sheetNames: [], setupStatus: 'UNKNOWN', configuredById: false};
  try {
    var explicitId = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || PE.SPREADSHEET_ID || '').trim();
    var ss = getSpreadsheet_();
    result.name = ss.getName();
    result.id = ss.getId();
    result.url = ss.getUrl();
    result.configuredById = !!explicitId;
    result.sheetNames = ss.getSheets().map(function(sh) { return sh.getName(); });
    var missing = PE.TABS.filter(function(name) { return !ss.getSheetByName(name); });
    var mismatched = PE.TABS.filter(function(name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return false;
      var expected = PE.TAB_HEADERS[name];
      if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) return true;
      var actual = sh.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
      return !expected.every(function(header, index) { return actual[index] === header; });
    });
    var prospectsSheet = ss.getSheetByName('Prospects');
    if (prospectsSheet && prospectsSheet.getLastColumn() !== PE.PROSPECTS_FULL_HEADERS.length) mismatched.push('Prospects verification columns');
    else if (prospectsSheet) {
      var verificationHeaders = prospectsSheet.getRange(1,PE.PROSPECTS_LEGACY_WIDTH+1,1,PE.PROSPECTS_VERIFICATION_HEADERS.length).getDisplayValues()[0];
      if (verificationHeaders.join('\u001f') !== PE.PROSPECTS_VERIFICATION_HEADERS.join('\u001f')) mismatched.push('Prospects verification columns');
    }
    result.setupStatus = missing.length || mismatched.length ? 'NEEDS_SETUP' : 'READY';
    if (missing.length) result.missingTabs = missing;
    if (mismatched.length) result.headerIssues = mismatched;
  } catch (error) {
    result.setupStatus = 'ERROR';
    result.error = String(error && error.message ? error.message : error);
  }
  Logger.log('SPREADSHEET_DIAGNOSTIC ' + JSON.stringify(result));
  return result;
}

