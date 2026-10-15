// Candidate research is evidence-led and does not scrape company sites automatically.
// URLs and evidence snippets are entered only after a manual review of official pages.
function researchCompany(candidate){
  var assessment=qualifyPilotCandidate_(candidate||{});
  if(!assessment.qualified)return {status:'NEEDS_REVIEW',reason:assessment.reasons.join('; '),score:assessment.score.score};
  return {status:'OK',domain:normalizeDomain(candidate.website),companyName:candidate.companyName,city:candidate.city,address:candidate.address||'',
    industry:candidate.industry,brandEvidence:candidate.brandEvidence,physicalProductsEvidence:candidate.physicalProductsEvidence,
    packagingOpportunity:candidate.packagingOpportunity||'Consumer-packaged physical product; packaging fit requires sales review.',
    sourceUrl:candidate.sourceUrl,locationEvidenceUrl:candidate.locationEvidenceUrl,productEvidenceUrl:candidate.productEvidenceUrl,
    contactSourceUrl:candidate.contactSourceUrl||'',researchStatus:'QUALIFIED',icpScore:assessment.score.score};
}
function extractTitle_(html){var m=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html||'');return m?m[1].replace(/\s+/g,' ').trim():'';}
function researchDecisionMakers(candidate){
  candidate=candidate||{};var source=hasHttpUrl_(candidate.contactSourceUrl)?candidate.contactSourceUrl:'';
  if(!source)return {pocName:'',designation:'',department:'',email:'',pocPhone:'',linkedin:''};
  return {pocName:candidate.pocName||'',designation:candidate.designation||'',department:candidate.department||'',email:candidate.email||'',pocPhone:candidate.pocPhone||'',linkedin:candidate.linkedin||''};
}
