const assert=require('node:assert/strict');
const {test}=require('node:test');
const {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync}=require('node:fs');
const {mkdir,readFile,writeFile}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {fileURLToPath,pathToFileURL}=require('node:url');
const vm=require('node:vm');
const {createDesktopBrowserBridge,preference,taskPath,publicOrigin,formatPairingCode,maskPairingCode,parsePairingCode}=require('../browser-bridge.cjs');
const extensionOrigin='chrome-extension://'+'a'.repeat(32);
const scope={appId:'app',taskId:'a'.repeat(32),session:randomUUID()};
function fixture({consent=true,onChange}={}){
  const dir=mkdtempSync(join(tmpdir(),'1904-browser-'));
  let job,confirmations=0,handler,controller='agent';const delivered=[];
  const fetchServer=async(url,init={})=>{
    if(init.method==='POST'){delivered.push(JSON.parse(init.body).browserInput);job=undefined;return Response.json({});}
    return Response.json({browser:{id:scope.session,status:'active',source:'desktop',controller,desktopRequest:job}});
  };
  const bridge=createDesktopBrowserBridge({file:join(dir,'prefs.json'),fetch:fetchServer,origin:'https://1904.ai',confirm:async()=>{confirmations++;return consent;},onChange,serverFactory:fn=>{handler=fn;return {once(){},removeListener(){},listen(_port,_host,ready){ready();},address:()=>({port:43001}),close(){}};}});
  const prepare=operation=>{job={id:randomUUID(),operation,payload:{},expiresAt:Date.now()+45_000};return {...scope,requestId:job.id};};
  return {bridge,dir,delivered,prepare,setController:value=>{controller=value;},handle:()=>handler,confirmations:()=>confirmations,close:()=>{bridge.close();rmSync(dir,{recursive:true,force:true});}};
}
async function connection(f){
  const {bridge}=f;
  const rawCode=await bridge.setup();
  const parsed=parsePairingCode(rawCode);
  const post=async(urlPath,value={},origin=extensionOrigin,key=parsed.key)=>new Promise(resolve=>{
    const headers={};let status=200;
    const req={method:'POST',url:urlPath,headers:{origin,host:'127.0.0.1:43001','x-1904-browser-key':key},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(value));}};
    const res={headersSent:false,setHeader:(name,value)=>{headers[name]=value;},writeHead:code=>{status=code;res.headersSent=true;},end:body=>resolve(new Response(body||'',{status,headers}))};
    f.handle()(req,res);
  });
  return {post,rawCode,parsed};
}
test('browser preference defaults per device, validates and persists',()=>{
  const f=fixture();try{
    assert.equal(preference('broken'),'auto');assert.equal(f.bridge.state().preference,'auto');
    f.bridge.setPreference('cloud');assert.equal(f.bridge.state().preference,'cloud');
    assert.equal(JSON.parse(readFileSync(join(f.dir,'prefs.json'))).preference,'cloud');
    assert.throws(()=>f.bridge.setPreference('other'),/preference/);
    assert.throws(()=>taskPath('../app',scope.taskId),/Invalid/);
    assert.throws(()=>publicOrigin('http://127.0.0.1'),/public/);
  }finally{f.close();}
});
test('setup produces a non-URL pairing code, hides the secret in previews, and parses modern and legacy codes',async()=>{
  const f=fixture();try{
    const code=await f.bridge.setup();
    assert.ok(!code.startsWith('http://'), 'pairing code must not look like a broken 127.0.0.1 web link');
    assert.match(code,/^1904-43001-[a-f0-9]{64}$/);
    const masked=maskPairingCode(code);
    assert.equal(masked,'1904-43001-••••••••');
    assert.ok(!masked.includes(code.slice(-16)),'masked preview never reveals the pairing token');
    const parsed=parsePairingCode(`  ${code}\n`);
    assert.equal(parsed.origin,'http://127.0.0.1:43001');
    assert.equal(parsed.key,code.split('-')[2]);
    const token='a'.repeat(64);
    assert.equal(formatPairingCode(43001,token),`1904-43001-${token}`);
    assert.deepEqual(parsePairingCode(`http://127.0.0.1:43001/#${token}`),{origin:'http://127.0.0.1:43001',key:token,port:43001});
    assert.throws(()=>parsePairingCode('https://example.com'),/1904-/);
    assert.throws(()=>parsePairingCode('1904-99999-'+token),/1904-/);
  }finally{f.close();}
});
test('only a paired extension can poll; native consent precedes exactly one server-issued operation',async()=>{
  const updates=[];
  const f=fixture({onChange:next=>updates.push(next)});try{
    const {post}=await connection(f);
    assert.equal((await post('/poll',{},'https://evil.test')).status,403);
    assert.equal((await post('/poll',{},extensionOrigin,'0'.repeat(64))).status,403);
    assert.equal((await post('/share',{url:'https://example.com/account',browser:'Chrome'})).status,200);
    assert.equal(f.bridge.state().available,true);
    assert.equal(f.bridge.state().site,'https://example.com');
    assert.equal(updates.at(-1).available,true);
    const input=f.prepare('attach');const execution=f.bridge.execute(input);
    let request;
    for(let tries=0;tries<30&&!request;tries++){request=(await (await post('/poll')).json()).request;if(!request)await new Promise(resolve=>setTimeout(resolve,2));}
    assert.equal(f.confirmations(),1);assert.equal(request.operation,'attach');
    assert.equal((await (await post('/poll')).json()).request,undefined,'poll never replays a sent operation');
    await post('/result',{id:request.id,ok:true,value:{url:'https://example.com/account'}});
    assert.deepEqual(await execution,{ok:true});assert.equal(f.delivered.length,1);
    await f.bridge.execute(input);assert.equal(f.delivered.length,1,'duplicate renderer request returns the original outcome');
    await assert.rejects(f.bridge.focus(scope),/Take control/);
    f.setController('user');const focusing=f.bridge.focus(scope);let focusJob;for(let tries=0;tries<30&&!focusJob;tries++){focusJob=(await (await post('/poll')).json()).request;if(!focusJob)await new Promise(resolve=>setTimeout(resolve,2));}
    assert.equal(focusJob.operation,'focus');await post('/result',{id:focusJob.id,ok:true,value:true});await focusing;assert.equal(f.delivered.length,1,'focusing is an owner UI action, not a runtime result');f.setController('agent');
    const action=f.prepare('action');const acting=f.bridge.execute(action);
    let next;for(let tries=0;tries<30&&!next;tries++){next=(await (await post('/poll')).json()).request;if(!next)await new Promise(resolve=>setTimeout(resolve,2));}
    await post('/result',{id:next.id,ok:false});assert.deepEqual(await acting,{ok:false});assert.equal(f.confirmations(),1);
    f.bridge.release({...scope,session:randomUUID()});assert.equal(f.bridge.state().available,true,'a different session cannot end the grant');
    f.bridge.release(scope);assert.equal(f.bridge.state().available,false);
    assert.equal(f.bridge.state().site,undefined);
    assert.equal(updates.at(-1).available,false);
  }finally{f.close();}
});
test('declining a task never releases its request to the extension',async()=>{
  const f=fixture({consent:false});try{
    const {post}=await connection(f);await post('/share',{url:'https://example.com',browser:'Chrome'});
    assert.deepEqual(await f.bridge.execute(f.prepare('attach')),{ok:false});
    assert.equal((await (await post('/poll')).json()).request,undefined);
    assert.equal(f.delivered[0].result.ok,false);
  }finally{f.close();}
});
test('after sleep the paired extension is asked once to share its tab again',async()=>{
  const f=fixture();try{
    const {post}=await connection(f);
    await post('/share',{url:'https://example.com/account',browser:'Chrome'});
    f.bridge.pause();assert.equal(f.bridge.state().available,false);
    assert.equal((await (await post('/poll')).json()).reshare,undefined,'never while asleep');
    f.bridge.resume();
    assert.equal((await (await post('/poll')).json()).reshare,true);
    assert.equal((await (await post('/poll')).json()).reshare,undefined,'asked once');
    f.bridge.pause();f.bridge.resume();await post('/share',{url:'https://example.com/account',browser:'Chrome'});
    assert.equal(f.bridge.state().available,true);assert.equal((await (await post('/poll')).json()).reshare,undefined,'a share answers it');
    f.bridge.pause();f.bridge.resume();await post('/disconnect');
    assert.equal((await (await post('/poll')).json()).reshare,undefined,'stopping sharing is final');
  }finally{f.close();}
});
test('Connect browser opens the guided Desktop window, stages 1904-browser-extension with README, and enforces sender checks',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'1904-connect-ui-'));
  const legacyDir=join(dir,'browser-extension');
  mkdirSync(legacyDir,{recursive:true});
  try{
    const main=readFileSync(join(__dirname,'..','main.cjs'),'utf8');
    const handlers=new Map(),copied=[],revealed=[],sent=[],loaded=[];
    const connectPage=join(__dirname,'..','browser-connect.html');
    const connectUrl=pathToFileURL(connectPage).href;
    let messageBoxCalls=0,createdWin;
    const token='b'.repeat(64);
    const code=formatPairingCode(43001,token);
    class FakeBrowserWindow{
      constructor(opts){
        this.opts=opts;this.destroyed=false;this.listeners={};
        const mainFrame={url:connectUrl};
        this.webContents={mainFrame,on:(ev,fn)=>{this.listeners[ev]=fn;},send:(ch,payload)=>{sent.push({ch,payload});}};
        createdWin=this;
      }
      isDestroyed(){return this.destroyed;}
      isMinimized(){return false;}
      restore(){}
      show(){}
      focus(){}
      on(){}
      loadFile(file){loaded.push(file);return Promise.resolve();}
    }
    const context=vm.createContext({
      path,process,fileURLToPath,existsSync,mkdir,readFile,writeFile,maskPairingCode,
      BROWSER_CONNECT_PAGE:connectPage,ICON:'',PALETTE:{dark:{color:'#121416'},light:{color:'#f6f8fa'}},
      SAFE_PREFERENCES:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false},
      __dirname:join(__dirname,'..'),
      BrowserWindow:FakeBrowserWindow,
      activeTheme:()=>'dark',
      app:{getPath:()=>dir,getAppPath:()=>join(__dirname,'..'),on:()=>{}},
      powerMonitor:{on:()=>{}},
      clipboard:{writeText:text=>copied.push(text)},
      shell:{showItemInFolder:target=>revealed.push(target)},
      messageBox:async()=>{messageBoxCalls++;return {response:0};},
      computerParent:()=>undefined,
      desktopBrowserBridge:{
        setup:async()=>code,
        state:()=>({preference:'auto',available:false,browser:'Chrome / Edge'}),
        setPreference:value=>({preference:value,available:false,browser:'Chrome / Edge'}),
        execute:async()=>({ok:true}),focus:async()=>{},release:()=>{},
      },
      browserConnectWindow:undefined,browserPairingCode:undefined,browserExtensionFolder:undefined,
      mainWindow:{isFocused:()=>true},dashboardContents:{isFocused:()=>true},
      computerInput:{decide:()=>({stamp:true})},
      isComputerDashboardSender:()=>true,isTaskTitleBarPage:()=>true,
      ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn)},
    });
    const start=main.indexOf('const BROWSER_EXTENSION_FILES');
    const end=main.indexOf('// ── Deploy From This Computer',start);
    vm.runInContext(main.slice(start,end)+'\ninstallDesktopBrowserHandlers();',context);

    await handlers.get('1904:browser-setup')({});
    assert.equal(messageBoxCalls,0,'must open the guided window instead of a one-shot messageBox');
    assert.deepEqual(loaded,[connectPage]);
    const staged=join(dir,'extensions','1904-browser-extension');
    for(const name of ['manifest.json','popup.html','popup.js','worker.js','README.txt']){
      assert.equal(existsSync(join(staged,name)),true,`staged ${name}`);
      assert.equal(existsSync(join(legacyDir,name)),true,`refreshed legacy ${name}`);
    }

    const validEvent={sender:createdWin.webContents,senderFrame:createdWin.webContents.mainFrame};
    const badEvent={sender:{},senderFrame:{url:'https://evil.test'}};
    const view=handlers.get('1904:browser-connect-state')(validEvent);
    assert.equal(view.codePreview,'1904-43001-••••••••');
    assert.ok(!JSON.stringify(view).includes(token),'raw pairing secret never crosses IPC into the window');
    assert.equal(handlers.get('1904:browser-connect-state')(badEvent),null);

    assert.equal(await handlers.get('1904:browser-connect-copy-code')(badEvent),false);
    assert.equal(await handlers.get('1904:browser-connect-copy-code')(validEvent),true);
    assert.equal(copied.at(-1),code);

    assert.equal(handlers.get('1904:browser-connect-copy-url')(validEvent,'chrome://extensions'),true);
    assert.equal(copied.at(-1),'chrome://extensions');
    assert.equal(handlers.get('1904:browser-connect-copy-url')(validEvent,'https://evil.test'),false);

    assert.equal(await handlers.get('1904:browser-connect-open-folder')(validEvent),true);
    assert.equal(revealed.at(-1),staged);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
