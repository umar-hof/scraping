function validateEmail(email){ if(!email)return {status:'UNVERIFIED',value:''}; var value=String(email).trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value))return {status:'INVALID',value:value}; return {status:'FORMAT_VALID',value:value}; }
function validatePhone(phone){ if(!phone)return {status:'UNVERIFIED',value:''}; var digits=String(phone).replace(/\D/g,''); if(digits.length===10)digits='1'+digits; var national=digits.slice(1); if(digits.length!==11||digits.charAt(0)!=='1'||!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)||national.slice(1,3)==='11')return {status:'INVALID',value:String(phone)}; return {status:'FORMAT_VALID',value:'+'+digits}; }
function normalizeDomain(url){ if(!url)return ''; try {var s=String(url).trim(); if(s.indexOf('://')<0)s='https://'+s; var h=new URL(s).hostname.toLowerCase().replace(/^www\./,''); return h;} catch(e){return '';} }
function isArizona(city,address){ var x=((city||'')+' '+(address||'')).toLowerCase(); return /arizona|\baz\b/.test(x) || PE.CITIES.some(function(c){return x.indexOf(c.toLowerCase())>=0;}); }
function stableId_(value){
  var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value),Utilities.Charset.UTF_8);
  return digest.map(function(byte){return ('0'+(byte&255).toString(16)).slice(-2);}).join('').slice(0,24);
}

