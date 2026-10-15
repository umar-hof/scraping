function checkDuplicate(record){
  var ss=getSpreadsheet_(),sh=ss.getSheetByName('Prospects');
  if(!sh||sh.getLastRow()<2)return {duplicate:false};
  var domain=normalizeDomain(record.website||record.companyDomain),name=normalizeCompanyName_(record.companyName),city=normalizeCompanyName_(record.city);
  var email=String(record.email||'').trim().toLowerCase(),pocPhone=normalizePhoneForDedupe_(record.pocPhone),rows=sh.getDataRange().getValues();
  for(var i=1;i<rows.length;i++){
    var row=rows[i],existingDomain=normalizeDomain(row[10]||row[9]),existingName=normalizeCompanyName_(row[0]),existingCity=normalizeCompanyName_(row[11]);
    if(domain&&existingDomain===domain)return {duplicate:true,row:i+1,reason:'company domain'};
    if(name&&existingName===name&&city&&existingCity===city)return {duplicate:true,row:i+1,reason:'company name and city'};
    if(email&&String(row[4]||'').trim().toLowerCase()===email)return {duplicate:true,row:i+1,reason:'contact email'};
    if(pocPhone&&normalizePhoneForDedupe_(row[2])===pocPhone)return {duplicate:true,row:i+1,reason:'POC phone'};
    if(record.leadId&&String(row[24]||'')===String(record.leadId))return {duplicate:true,row:i+1,reason:'lead ID'};
  }
  return {duplicate:false};
}
function normalizePhoneForDedupe_(value){var digits=String(value||'').replace(/\D/g,'');if(digits.length===10)digits='1'+digits;return digits.length===11&&digits.charAt(0)==='1'?digits:'';}
