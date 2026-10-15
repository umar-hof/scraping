var PE = (typeof PE === 'undefined') ? {} : PE;
PE.VERSION = '1.0.0';
PE.SPREADSHEET_ID = '';
PE.TAB_HEADERS = {
  'Prospects': ['Company Name','Designation','POC Contact Number','Company Contact Number','POC Email ID','Department','Employee Size','LI POC Profile','POC Name','Company Website','Company Domain','Arizona City','Arizona Address','Industry','ICP Score','Brand Ownership Evidence','Packaging Opportunity','Source URL','Contact Source URL','Email Verification Status','Phone Verification Status','Research Status','Last Checked','Date Added','Lead ID','Notes'],
  'ICP Notes': ['Lead ID','Score','Category','Explanation','Evidence','Created At'],
  'Run Logs': ['Run ID','Started At','Finished At','Candidates Discovered','Candidates Researched','Qualified Companies','POCs Found','Emails Found','Phone Numbers Found','New Rows Appended','Duplicates Skipped','Errors','Execution Duration','Status'],
  'Review Queue': ['Queue ID','Candidate ID','Reason','Source Evidence','Status','Created At','Notes'],
  'Source Registry': ['Source ID','Source Name','Source URL','Source Type','Access Permission Status','Last Successful Check','Rate Limit / sec','Discovery Cursor','Last Error','Enabled'],
  'Settings': ['Setting','Value','Description'],
  'Daily Summary': ['Date','Total Prospects','New Prospects Today','Qualified Prospects','Records With POC Email','Records With POC Phone','Source-Listed Contacts','Independently Verified Contacts','Pending Research','Duplicates','Failed Research','Source Coverage']
};
// Appended after the immutable 26-column legacy Prospects schema.
PE.PROSPECTS_VERIFICATION_HEADERS = [
  'Company Email','Company Email Source URL','POC Email Source URL','Email Syntax Status',
  'Email Domain MX Status','Email Deliverability Status','Email Last Verified',
  'Company Phone Source URL','POC Phone Source URL','Phone Format Status',
  'Phone Activity Status','Phone Last Verified','LinkedIn Source URL',
  'Employee Size Source URL','Contact Completeness Score','Verification Notes'
];
PE.PROSPECTS_LEGACY_WIDTH = PE.TAB_HEADERS.Prospects.length;
PE.PROSPECTS_FULL_HEADERS = PE.TAB_HEADERS.Prospects.concat(PE.PROSPECTS_VERIFICATION_HEADERS);
PE.TABS = Object.keys(PE.TAB_HEADERS);
function getSpreadsheet_() {
  var id = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || PE.SPREADSHEET_ID || '').trim();
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (!active) throw new Error('No active spreadsheet. Set the SPREADSHEET_ID script property to the target spreadsheet ID.');
  return active;
}
PE.SETTINGS_DEFAULTS = {
  'Automation Enabled': false, 'Batch Size': 25, 'Maximum Execution Time': 300000,
  'Minimum ICP Score': 60, 'Arizona Only': true, 'Allowed Industries': 'ALL',
  'Preferred Employee Range': '2-50', 'Require POC Name': false, 'Require POC Email': false,
  'Require Company Phone': false, 'Allow Unverified Contacts': true, 'Source Rate Limit': 2,
  'Maximum Retries': 3, 'Research Timeout': 15000, 'Daily Summary Enabled': true,
  'Outreach Enabled': false
};
PE.INDUSTRY_SCORES = {'Cosmetics & Skincare Brands':92,'Candles & Home Fragrance':88,'Specialty Coffee, Tea & Food':86,'Supplements & Wellness':84,'Soap, Bath & Body':80,'E-commerce / DTC Lifestyle':78,'Subscription Box Companies':72,'Gifting, Events & Corporate Gifts':66,'Bakeries & Restaurants':55};
PE.CITIES = ['Phoenix','Tucson','Mesa','Chandler','Scottsdale','Tempe','Gilbert','Glendale','Peoria','Surprise','Goodyear','Buckeye','Avondale','Flagstaff','Prescott','Prescott Valley','Sedona','Yuma','Casa Grande','Maricopa','Queen Creek','Sierra Vista','Lake Havasu City','Kingman','Payson','Cottonwood','Show Low'];
PE.DEPARTMENT_BY_ROLE = {'founder':'Founder/Executive','co-founder':'Founder/Executive','owner':'Founder/Executive','ceo':'Founder/Executive','president':'Founder/Executive','operations':'Operations','supply chain':'Supply Chain','brand':'Brand/Marketing','marketing':'Brand/Marketing','purchasing':'Purchasing/Procurement','procurement':'Purchasing/Procurement','e-commerce':'E-commerce','ecommerce':'E-commerce','product':'Product Development'};
PE.STAGES = ['PENDING','RESEARCHING','QUALIFIED','REJECTED','NEEDS_REVIEW','COMPLETED','RETRY_WAIT','FAILED'];
function getSetting_(name) { var s = PE.SETTINGS_DEFAULTS[name]; try { var sh=getSpreadsheet_().getSheetByName('Settings'); if(sh){ var v=sh.getDataRange().getValues(); for(var i=1;i<v.length;i++) if(v[i][0]===name) return v[i][1]; } } catch(e){} return s; }
function now_(){ return new Date(); }

