function prioritizeDecisionMaker_(contact){var t=String(contact.designation||'').toLowerCase(); var order=['founder','owner','ceo','president','operations','supply chain','brand','marketing','purchasing','procurement','e-commerce','ecommerce','product']; for(var i=0;i<order.length;i++)if(t.indexOf(order[i])>=0)return i; return 99;}
function departmentForTitle_(title){var t=String(title||'').toLowerCase(); for(var k in PE.DEPARTMENT_BY_ROLE)if(t.indexOf(k)>=0)return PE.DEPARTMENT_BY_ROLE[k]; return 'Other';}

