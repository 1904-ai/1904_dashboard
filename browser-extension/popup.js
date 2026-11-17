'use strict';
document.querySelector('#connect').addEventListener('submit',async event=>{
  event.preventDefault();
  const status=document.querySelector('#status');status.textContent='Connecting…';
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const result=await chrome.runtime.sendMessage({operation:'share',code:document.querySelector('#code').value,tabId:tab.id});
    status.textContent=result?.ok?'Tab shared. Approve the task in 1904 Desktop when prompted.':result?.error||'Could not share this tab.';
  }catch{status.textContent='Could not connect. Copy a fresh code from Desktop Settings.';}
});
document.querySelector('#stop').addEventListener('click',async()=>{await chrome.runtime.sendMessage({operation:'stop'});document.querySelector('#status').textContent='Sharing stopped.';});
