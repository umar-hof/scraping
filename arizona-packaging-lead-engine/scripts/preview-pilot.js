const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function parseCsv(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}
    else if(ch==='"')quoted=true;
    else if(ch===','){row.push(field);field='';}
    else if(ch==='\n'){row.push(field);rows.push(row);row=[];field='';}
    else if(ch!=='\r')field+=ch;
  }
  if(field||row.length){row.push(field);rows.push(row);}
  return rows;
}

const root=path.join(__dirname,'..');
const sourceDir=path.join(root,'apps-script');
const context={URL,Date,JSON,Math,String,Number,Object,Array,RegExp,Error,console,Logger:{log(){}},Utilities:{parseCsv},PE:undefined};
vm.createContext(context);
['Config.gs','Validation.gs','ICPScoring.gs','Sources.gs','CompanyResearch.gs','Deduplication.gs'].forEach(file=>vm.runInContext(fs.readFileSync(path.join(sourceDir,file),'utf8'),context,{filename:file}));
context.getSetting_=()=>60;
context.getSpreadsheet_=()=>({getSheetByName:()=>({getLastRow:()=>1})});

const csv=fs.readFileSync(path.join(root,'pilot-data','arizona-physical-product-candidates.csv'),'utf8');
const result=context.previewCandidatesCsv(csv,'MANUAL_OFFICIAL_WEB_REVIEW');
console.log(JSON.stringify({mode:'LOCAL_READ_ONLY_PREVIEW',liveSheetChecked:false,summary:result.summary,candidates:result.candidates.map(({company,status,score,reasons})=>({company,status,score,reasons}))},null,2));
if(result.summary.input!==20||result.summary.qualified+result.summary.needsReview+result.summary.duplicatesInFile+result.summary.duplicatesInProspects!==result.summary.input)process.exitCode=1;
