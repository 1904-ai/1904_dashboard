'use strict';
let connection,tabId,site,attached=false,revision=0,looping=false,generation=0,executing=false,lastPoint={x:0,y:0};
const PAIRING_CODE=/^1904-([1-9]\d{0,4})-([a-f0-9]{64})$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cdp=(method,params={})=>chrome.debugger.sendCommand({tabId},method,params);
function parsePairingCode(raw){
  const text=String(raw||'').trim();
  const modern=PAIRING_CODE.exec(text);
  if(modern){
    const port=Number(modern[1]);
    if(port>=1&&port<=65535)return {origin:`http://127.0.0.1:${port}`,key:modern[2]};
  }
  try{
    const url=new URL(text);
    const port=Number(url.port);
    if(url.protocol==='http:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&url.hostname==='127.0.0.1'&&Number.isInteger(port)&&port>=1&&port<=65535&&/^#([a-f0-9]{64})$/.test(url.hash)){
      return {origin:url.origin,key:url.hash.slice(1)};
    }
  }catch{}
  throw Error('Paste the pairing code from 1904 Desktop (starts with 1904-).');
}
function publicSite(raw){
  let u;
  try{u=new URL(raw);}catch{throw Error('Switch to a public website tab first (http:// or https://).');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||!u.hostname.includes('.')||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||u.hostname.includes(':')||/^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(u.hostname))throw Error('Switch to a public website tab first (browser settings and local pages cannot be shared).');
  return u.origin;
}
async function post(path,body){const r=await fetch(connection.origin+path,{method:'POST',headers:{'content-type':'application/json','x-1904-browser-key':connection.key},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});if(!r.ok)throw Error('Desktop connection unavailable.');return r.json();}
async function guard(){if(!connection||!Number.isInteger(tabId))throw Error('No tab shared.');const tab=await chrome.tabs.get(tabId);if(publicSite(tab.url)!==site)throw Error('The tab changed websites. Share it again.');if(!attached)throw Error('Sharing is paused.');}
async function attach(){if(!attached){await chrome.debugger.attach({tabId},'1.3');attached=true;await cdp('Page.enable');await cdp('Page.setDownloadBehavior',{behavior:'deny'});await cdp('Fetch.enable',{patterns:[{resourceType:'Document',requestStage:'Request'}]});await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});}await guard();}
async function detach(){if(attached){attached=false;try{await cdp('Page.setDownloadBehavior',{behavior:'default'});}catch{}try{await cdp('Emulation.clearDeviceMetricsOverride');}catch{}try{await chrome.debugger.detach({tabId});}catch{/* Chrome may already have detached. */}}}
async function stop(){generation++;const old=connection;await detach();connection=undefined;tabId=undefined;site=undefined;await chrome.storage.session.remove('connection');if(old){try{await fetch(old.origin+'/disconnect',{method:'POST',headers:{'content-type':'application/json','x-1904-browser-key':old.key},body:'{}',signal:AbortSignal.timeout(2000)});}catch{/* The local app may be closed. */}}}
// Always run fixed code in an isolated world. Requests cannot supply JavaScript or a CDP method.
async function inPage(operation,args={}){
  await guard();
  const {frameTree}=await cdp('Page.getFrameTree');
  const {executionContextId}=await cdp('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'1904-browser'});
  const answer=await cdp('Runtime.evaluate',{contextId:executionContextId,expression:'('+pageOperation.toString()+')('+JSON.stringify(operation)+','+JSON.stringify(args)+')',returnByValue:true,awaitPromise:true});
  if(answer.exceptionDetails)throw Error('Page operation failed.');return answer.result?.value;
}
function pageOperation(operation,args){
  const visible=el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
  const label=el=>String(el.getAttribute('aria-label')||Array.from(el.labels||[]).map(item=>item.innerText).join(' ')||el.innerText||el.getAttribute('placeholder')||el.tagName).replace(/\s+/g,' ').trim().slice(0,160);
  function find(selector){
    if(typeof selector!=='string'||selector.length>300)throw Error('Invalid selector.');
    let items;
    const role=/^role=([\w-]+)(?:\[name=["'](.*)["']\])?$/.exec(selector);
    if(role){const tags={button:'button,input[type=submit],input[type=button]',link:'a[href]',textbox:'input:not([type=password]),textarea',combobox:'select',checkbox:'input[type=checkbox]'};items=Array.from(document.querySelectorAll('[role="'+role[1]+'"]'+(tags[role[1]]?','+tags[role[1]]:''))).filter(el=>!role[2]||label(el)===role[2]);}
    else if(selector.startsWith('text=')){const text=selector.slice(5).replace(/^["']|["']$/g,'');items=Array.from(document.querySelectorAll('button,a,label,summary,p,h1,h2,h3')).filter(el=>el.innerText.trim()===text);}
    else items=Array.from(document.querySelectorAll(selector));
    items=items.filter(visible);if(items.length!==1)throw Error('Choose exactly one visible element.');return items[0];
  }
  function selector(el){if(el.id)return '#'+CSS.escape(el.id);const path=[];for(let node=el;node&&node!==document.body;node=node.parentElement){const tag=node.tagName.toLowerCase(),siblings=Array.from(node.parentElement?.children||[]).filter(other=>other.tagName===node.tagName);path.unshift(tag+':nth-of-type('+(siblings.indexOf(node)+1)+')');}return 'body > '+path.join(' > ');}
  if(operation==='snapshot'){
    const nodes=Array.from(document.querySelectorAll('h1,h2,h3,p,button,a[href],input,textarea,select,summary,[role]')).filter(visible).slice(0,120);
    const tree=nodes.map(el=>'- '+(el.getAttribute('role')||el.tagName.toLowerCase())+' '+JSON.stringify(label(el))+' [selector='+selector(el)+']').join('\n').slice(0,14000);
    const values=Array.from(document.querySelectorAll('input,textarea,select')).map(el=>[el.value,el.checked]);
    return {url:location.href,title:document.title,tree,hashInput:document.documentElement.outerHTML+JSON.stringify(values)};
  }
  const el=find(args.selector);
  if(operation==='target')return label(el);
  if(operation==='locate'){el.scrollIntoView({block:'center',inline:'center'});const b=el.getBoundingClientRect();if(el.disabled)throw Error('Disabled control.');el.focus();return {x:b.x+b.width/2,y:b.y+b.height/2};}
  if(operation==='fill'){
    if(!['INPUT','TEXTAREA'].includes(el.tagName)||el.type==='file')throw Error('Choose a text field.');
    const proto=el.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(args.value));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;
  }
  if(operation==='select'){if(el.tagName!=='SELECT')throw Error('Choose a select control.');const option=Array.from(el.options).find(item=>item.value===args.value||item.label===args.value);if(!option)throw Error('Option not found.');el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}
  if(operation==='scroll'){el.scrollIntoView({block:'center'});return true;}
  if(operation==='text'){if(el.innerText!==args.value)throw Error('Text differs.');return true;}
  if(operation==='visible')return true;
  throw Error('Unsupported page operation.');
}
async function observe(){
  const data=await inPage('snapshot');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.hashInput));delete data.hashInput;
  data.fingerprint=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');data.revision=revision;
  const shot=await cdp('Page.captureScreenshot',{format:'jpeg',quality:30,clip:{x:0,y:0,width:1280,height:800,scale:1},captureBeyondViewport:false});
  if(shot.data.length<=174_760)data.frame=shot.data;
  data.url=data.url.slice(0,4000);data.title=data.title.slice(0,120);return data;
}
async function key(value){
  if(typeof value!=='string'||value.length>80)throw Error('Invalid key.');
  const parts=value.split('+'),name=parts.pop(),modifiers=parts.reduce((bits,part)=>bits|({Alt:1,Control:2,ControlOrMeta:2,Meta:4,Shift:8}[part]||0),0);
  if(!['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space','a','A'].includes(name))throw Error('Unsupported key.');
  if(modifiers&&!(name.toLowerCase()==='a'&&(modifiers===2||modifiers===4)))throw Error('Browser shortcuts are not shared.');
  const codes={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Space:32,a:65,A:65};
  const event={key:name==='Space'?' ':name,modifiers,windowsVirtualKeyCode:codes[name]||0};
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',...event});await cdp('Input.dispatchKeyEvent',{type:'keyUp',...event});
}
async function input(value){
  await guard();
  if(!value||typeof value!=='object')throw Error('Invalid input.');
  if(value.type==='text'){if(typeof value.value!=='string'||value.value.length>4000)throw Error('Invalid text.');await cdp('Input.insertText',{text:value.value});return;}
  if(value.type==='key'){await key(value.value);return;}
  const x=value.x??lastPoint.x,y=value.y??lastPoint.y;if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=1280||y>=800)throw Error('Input outside tab.');lastPoint={x,y};
  const button=['left','middle','right'].includes(value.button)?value.button:'left';
  const send=type=>cdp('Input.dispatchMouseEvent',{type,x,y,button,clickCount:type==='mouseMoved'?0:1});
  if(value.type==='wheel'){if(![value.dx,value.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000))throw Error('Invalid wheel.');await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:value.dx,deltaY:value.dy});}
  else if(value.type==='click'){await send('mousePressed');await send('mouseReleased');}
  else if(['move','down','up'].includes(value.type))await send({move:'mouseMoved',down:'mousePressed',up:'mouseReleased'}[value.type]);
  else throw Error('Unsupported input.');
}
async function action(step){
  if(!step||typeof step.action!=='string')throw Error('Invalid action.');
  if(step.action==='wait'){await sleep(Math.min(5000,Math.max(0,Number(step.value)||500)));return;}
  if(['fill','select','scroll','text','visible'].includes(step.action)){await inPage(step.action,step);return;}
  const point=await inPage('locate',step);
  if(step.action==='press'){await key(step.value);return;}
  if(step.action==='type'){await input({type:'text',value:step.value});return;}
  if(step.action==='hover'){await input({type:'move',...point});return;}
  if(step.action==='wheel'){const parts=String(step.value).split(',').map(Number);await input({type:'wheel',...point,dx:parts[0],dy:parts[1]});return;}
  if(['click','dblclick','rightclick','tap'].includes(step.action)){await input({type:'click',...point,button:step.action==='rightclick'?'right':'left'});if(step.action==='dblclick')await input({type:'click',...point});return;}
  throw Error('This action is not supported in the shared desktop tab.');
}
async function execute(request){
  if(!request||!Number.isFinite(request.expiresAt)||Date.now()>=request.expiresAt)throw Error('Browser request expired.');
  if(request.operation==='attach'){await attach();return observe();}
  await guard();
  if(request.operation==='focus'){await chrome.tabs.update(tabId,{active:true});const tab=await chrome.tabs.get(tabId);await chrome.windows.update(tab.windowId,{focused:true});return true;}
  if(request.operation==='target')return inPage('target',request.payload);
  if(request.operation==='navigate'){
    if(publicSite(request.payload.url)!==site)throw Error('Share the destination website first.');
    await cdp('Page.navigate',{url:request.payload.url});await sleep(700);
  }else if(request.operation==='action')await action(request.payload.action);
  else if(request.operation==='input')await input(request.payload.input);
  else if(request.operation!=='observe')throw Error('Unsupported operation.');
  return observe();
}
async function loop(){
  if(looping)return;looping=true;const mine=generation;
  try{while(connection&&mine===generation){
    try{
      await chrome.storage.session.get('connection'); // Extension activity keeps the connection alive while shared.
      const {request,release,reshare}=await post('/poll',{});if(mine!==generation)break;
      if(release)await detach();
      // Desktop ended sharing while the computer slept: share the same tab again (guard stops if it changed websites).
      if(reshare){await attach();const tab=await chrome.tabs.get(tabId);await post('/share',{url:tab.url,browser:navigator.userAgent.includes('Edg/')?'Edge':'Chrome'});}
      if(request){let result;executing=true;try{result={ok:true,value:await execute(request)};}catch{result={ok:false};}finally{executing=false;}if(mine===generation&&connection)await post('/result',{id:request.id,...result});}
    }catch{if(mine===generation)await stop();break;}
    await sleep(500);
  }}finally{looping=false;if(connection&&mine!==generation)void loop();}
}
const USER_ERRORS=new Set([
  'Choose a tab.',
  'Paste the pairing code from 1904 Desktop (starts with 1904-).',
  'Switch to a public website tab first (http:// or https://).',
  'Switch to a public website tab first (browser settings and local pages cannot be shared).',
]);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('popup.html')))return;
  void(async()=>{
    if(message.operation==='status')return {ok:true,connected:Boolean(connection&&attached&&site),site:site||''};
    if(message.operation==='stop'){await stop();return {ok:true};}
    if(executing)return {ok:false,error:'A browser operation is settling. Stop sharing, then try again.'};
    if(message.operation!=='share'||!Number.isInteger(message.tabId))throw Error('Choose a tab.');
    const parsed=parsePairingCode(message.code);
    const tab=await chrome.tabs.get(message.tabId),chosenSite=publicSite(tab.url);
    await stop();connection={origin:parsed.origin,key:parsed.key};tabId=message.tabId;site=chosenSite;revision=0;
    await attach();await post('/share',{url:tab.url,browser:navigator.userAgent.includes('Edg/')?'Edge':'Chrome'});
    await chrome.storage.session.set({connection:{...connection,tabId,site}});void loop();return {ok:true,site:chosenSite};
  })().then(reply,async error=>{
    const known=USER_ERRORS.has(error?.message)?error.message:'';
    if(!known)await stop();
    reply({ok:false,error:known||'Could not reach 1904 Desktop. Make sure 1904 Desktop is open and copy a fresh pairing code from Connect your browser.'});
  });return true;
});
chrome.debugger.onEvent.addListener((source,method,params)=>{
  if(source.tabId!==tabId)return;
  if(method==='Fetch.requestPaused'){let permitted=false;try{permitted=publicSite(params.request.url)===site;}catch{}void cdp(permitted?'Fetch.continueRequest':'Fetch.failRequest',permitted?{requestId:params.requestId}:{requestId:params.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}
  if(method==='Page.frameNavigated'&&!params.frame.parentId){revision++;try{if(publicSite(params.frame.url)!==site)void stop();}catch{void stop();}}
  if(method==='Page.javascriptDialogOpening')void cdp('Page.handleJavaScriptDialog',{accept:false}).catch(()=>{});
});
chrome.debugger.onDetach.addListener(source=>{if(source.tabId===tabId){const wasAttached=attached;attached=false;if(wasAttached)void stop();}});
chrome.tabs.onRemoved.addListener(id=>{if(id===tabId)void stop();});
void chrome.storage.session.get('connection').then(async saved=>{if(!saved.connection)return;connection={origin:saved.connection.origin,key:saved.connection.key};tabId=saved.connection.tabId;site=saved.connection.site;attached=true;try{await guard();void loop();}catch{await stop();}});
