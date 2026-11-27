'use strict';
const status=document.querySelector('#status');
const connected=document.querySelector('#connected');
function setStatus(text,kind=''){status.textContent=text;status.dataset.kind=kind;}
function showConnected(site){
  if(site){let label=site;try{label=new URL(site).host||site;}catch{}connected.textContent=`Currently sharing a tab on ${label}.`;connected.hidden=false;}
  else{connected.textContent='';connected.hidden=true;}
}
void chrome.runtime.sendMessage({operation:'status'}).then(result=>{
  if(result?.connected&&result.site)showConnected(result.site);
}).catch(()=>{});
document.querySelector('#connect').addEventListener('submit',async event=>{
  event.preventDefault();
  setStatus('Connecting…');
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const result=await chrome.runtime.sendMessage({operation:'share',code:document.querySelector('#code').value.trim(),tabId:tab.id});
    if(result?.ok){showConnected(result.site||'');setStatus('Tab shared. Approve the task in 1904 Desktop when prompted.','ok');}
    else setStatus(result?.error||'Could not share this tab.','error');
  }catch{setStatus('Could not reach 1904 Desktop. Make sure 1904 Desktop is open and copy a fresh pairing code.','error');}
});
document.querySelector('#stop').addEventListener('click',async()=>{
  await chrome.runtime.sendMessage({operation:'stop'});
  showConnected('');
  setStatus('Sharing stopped.');
});
