'use strict';
const {createServer} = require('node:http');
const {randomBytes, randomUUID, timingSafeEqual} = require('node:crypto');
const {writeFileSync,renameSync} = require('node:fs');
const {readState} = require('./desktop-state.cjs');
const PREFERENCES = new Set(['auto','desktop','cloud']);
const OPERATIONS = new Set(['attach','observe','navigate','target','action','input']);
const ID = /^[a-f0-9-]{36}$/;
const TASK = /^[a-f0-9]{32}$/;
const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_BYTES = 300_000;
function preference(value) { return PREFERENCES.has(value) ? value : 'auto'; }
function taskPath(appId, taskId) {
  if(typeof appId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(appId)||!TASK.test(taskId)) throw new Error('Invalid browser task.');
  return `/api/apps/${encodeURIComponent(appId)}/agent-workspaces`;
}
/** The renderer supplies IDs, never operations. Read the actual owner-only request from 1904. */
function createDesktopBrowserBridge({file,fetch,origin,confirm,now=Date.now,serverFactory=createServer}) {
  let setting=preference(readState(file).preference),server,port,extensionOrigin,shared,lease,pending;
  let lastSeen=0,paused=false,releaseRequested=false,reshare=false;
  const token=randomBytes(32).toString('hex');
  const executed=new Map(),inFlight=new Set();
  function available() { return Boolean(shared&&now()-lastSeen<15_000); }
  const state=()=>({preference:setting,available:available(),browser:shared?.browser||'Chrome / Edge'});
  function end() {
    if(pending){clearTimeout(pending.timer);pending.reject(new Error('Desktop browser disconnected.'));pending=undefined;}
    lease=undefined;shared=undefined;releaseRequested=true;
  }
  async function readBody(req) {
    let bytes=0;const chunks=[];
    for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BYTES)throw new Error('Response too large.');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  }
  async function start() {
    if(server)return;
    server=serverFactory((req,res)=>{
      const requestOrigin=req.headers.origin;
      if(req.headers.host!==`127.0.0.1:${port}`||typeof requestOrigin!=='string'||!EXTENSION.test(requestOrigin)|| (extensionOrigin&&requestOrigin!==extensionOrigin)) {res.writeHead(403);res.end();return;}
      res.setHeader('Access-Control-Allow-Origin',requestOrigin);res.setHeader('Vary','Origin');res.setHeader('Cache-Control','no-store');
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','content-type,x-1904-browser-key');res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);res.end();return;}
      const supplied=String(req.headers['x-1904-browser-key']||'');
      if(req.method!=='POST'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) {res.writeHead(403);res.end();return;}
      void (async()=>{
        const body=await readBody(req);extensionOrigin=requestOrigin;lastSeen=now();
        let answer={};
        if(req.url==='/share'){
          end();shared={browser:body.browser==='Edge'?'Edge':'Chrome',origin:publicOrigin(body.url)};releaseRequested=false;reshare=false;
        } else if(req.url==='/poll') {
          // After sleep the extension is still paired: it shares the same tab again; each task still asks before using it.
          answer={request:pending&&!pending.sent?{id:pending.id,operation:pending.operation,payload:pending.payload,expiresAt:pending.expiresAt}:undefined,release:releaseRequested,...(reshare&&!paused?{reshare:true}:{})};
          if(pending)pending.sent=true;releaseRequested=false;if(!paused)reshare=false;
        } else if(req.url==='/result') {
          if(!pending||body.id!==pending.id)throw new Error('Request expired.');
          const job=pending;pending=undefined;clearTimeout(job.timer);
          if(body.ok===true)job.resolve(body.value);else job.reject(new Error('Browser operation failed. Inspect the page before retrying.'));
        } else if(req.url==='/disconnect'){reshare=false;end();}else {res.writeHead(404);res.end();return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer));
      })().catch(()=>{if(!res.headersSent)res.writeHead(400);res.end('{}');});
    });
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);port=server.address().port;resolve();});});}catch(error){server.close();server=undefined;throw error;}
  }
  function call(request) {
    if(!available()||pending)return Promise.reject(new Error('Share a browser tab from the 1904 extension first.'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(pending?.id===request.id){pending=undefined;lease=undefined;reject(new Error('Desktop browser timed out. No action was retried.'));}},30_000);
      pending={...request,resolve,reject,timer,sent:false};
    });
  }
  async function execute(input) {
    if(!input||!ID.test(input.session)||!ID.test(input.requestId)||input.taskTab!==undefined&&!/^t[a-f0-9]{8}$/.test(input.taskTab))throw new Error('Invalid browser request.');
    const path=taskPath(input.appId,input.taskId),key=input.session+':'+input.requestId;
    if(executed.has(key))return executed.get(key);
    if(inFlight.size>=32)throw new Error('Desktop browser is busy.');
    const work=(async()=>{
      const response=await fetch(origin+path+`?workspace=${input.taskId}&browser=1${input.taskTab?'&taskTab='+input.taskTab:''}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15_000)});
      if(!response.ok)throw new Error('Browser task is unavailable.');
      const {browser}=await response.json(),request=browser?.desktopRequest;
      if(browser?.source!=='desktop'||browser.status!=='active'||browser.id!==input.session||request?.id!==input.requestId||!OPERATIONS.has(request.operation))throw new Error('Browser request changed.');
      let result;
      try {
        if(paused||!available())throw new Error('Share a tab from the 1904 browser extension.');
        const scope=input.appId+':'+input.taskId+':'+input.session;
        if(!lease||lease.scope!==scope){
          if(request.operation!=='attach')throw new Error('Browser grant ended. Start a new browser session.');
          if(lease)throw new Error('The shared tab is in use by another task.');
          if(!(await confirm({site:shared.origin,taskId:input.taskId})))throw new Error('Browser sharing declined.');
          if(!available())throw new Error('Browser disconnected.');
          lease={scope,site:shared.origin};
        }
        if(!Number.isFinite(request.expiresAt)||now()>=request.expiresAt-1000)throw new Error('Browser request expired.');
        if(request.operation==='navigate'&&publicOrigin(request.payload?.url)!==lease.site)throw new Error('Share a tab on the destination website before starting a new session.');
        const check=await fetch(origin+path+`?workspace=${input.taskId}&browser=1${input.taskTab?'&taskTab='+input.taskTab:''}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10_000)});
        if(!check.ok||(await check.json()).browser?.desktopRequest?.id!==request.id)throw new Error('Browser request expired.');
        const value=await call({...request,expiresAt:Math.min(request.expiresAt,now()+25_000)});result={ok:true,value};
      } catch { result={ok:false}; }
      const posted=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({action:'conversation',id:input.taskId,...(input.taskTab?{taskTab:input.taskTab}:{}),command:'browser',browserInput:{operation:'desktop-result',session:input.session,requestId:input.requestId,result}}),signal:AbortSignal.timeout(15_000)});
      if(!posted.ok)throw new Error('Browser result could not be confirmed. It will not be replayed.');
      return {ok:result.ok};
    })();
    executed.set(key,work);inFlight.add(key);
    void work.then(()=>inFlight.delete(key),()=>inFlight.delete(key));
    if(executed.size>200){const oldest=[...executed.keys()].find(id=>!inFlight.has(id));if(oldest)executed.delete(oldest);}
    return work;
  }
  return {state,execute,
    async focus(input){
      const path=taskPath(input.appId,input.taskId);
      if(!ID.test(input.session)||input.taskTab!==undefined&&!/^t[a-f0-9]{8}$/.test(input.taskTab)||!lease||lease.scope!==input.appId+':'+input.taskId+':'+input.session)throw new Error('Share a tab with this task first.');
      const response=await fetch(origin+path+`?workspace=${input.taskId}&browser=1${input.taskTab?'&taskTab='+input.taskTab:''}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10_000)});
      if(!response.ok)throw new Error('Task unavailable.');const {browser}=await response.json();
      if(browser?.id!==input.session||browser.source!=='desktop'||browser.status!=='active'||browser.controller!=='user')throw new Error('Take control before opening the local tab.');
      await call({id:randomUUID(),operation:'focus',payload:{},expiresAt:now()+10_000});
    },
    setPreference(value){if(!PREFERENCES.has(value))throw new Error('Choose a browser preference.');writeFileSync(file+'.tmp',JSON.stringify({preference:value}),{mode:0o600});renameSync(file+'.tmp',file);setting=value;return state();},
    async setup(){await start();return `http://127.0.0.1:${port}/#${token}`;},
    release(input){if(lease&&lease.scope===input.appId+':'+input.taskId+':'+input.session)end();},
    pause(){paused=true;if(shared)reshare=true;end();},resume(){paused=false;},
    close(){end();server?.close();server=undefined;},
  };
}
function publicOrigin(raw) {
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)||url.hostname==='localhost'||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||!url.hostname.includes('.')||/^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(url.hostname)||url.hostname.includes(':'))throw new Error('Share a public website tab.');
  return url.origin;
}
module.exports={createDesktopBrowserBridge,preference,taskPath,publicOrigin};
