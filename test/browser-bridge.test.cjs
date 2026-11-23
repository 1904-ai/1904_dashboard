const assert=require('node:assert/strict');
const {test}=require('node:test');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {createDesktopBrowserBridge,preference,taskPath,publicOrigin}=require('../browser-bridge.cjs');
const extensionOrigin='chrome-extension://'+'a'.repeat(32);
const scope={appId:'app',taskId:'a'.repeat(32),session:randomUUID()};
function fixture({consent=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'1904-browser-'));
  let job,confirmations=0,handler,controller='agent';const delivered=[];
  const fetchServer=async(url,init={})=>{
    if(init.method==='POST'){delivered.push(JSON.parse(init.body).browserInput);job=undefined;return Response.json({});}
    return Response.json({browser:{id:scope.session,status:'active',source:'desktop',controller,desktopRequest:job}});
  };
  const bridge=createDesktopBrowserBridge({file:join(dir,'prefs.json'),fetch:fetchServer,origin:'https://1904.ai',confirm:async()=>{confirmations++;return consent;},serverFactory:fn=>{handler=fn;return {once(){},removeListener(){},listen(_port,_host,ready){ready();},address:()=>({port:43001}),close(){}};}});
  const prepare=operation=>{job={id:randomUUID(),operation,payload:{},expiresAt:Date.now()+45_000};return {...scope,requestId:job.id};};
  return {bridge,dir,delivered,prepare,setController:value=>{controller=value;},handle:()=>handler,confirmations:()=>confirmations,close:()=>{bridge.close();rmSync(dir,{recursive:true,force:true});}};
}
async function connection(f){
  const {bridge}=f;
  const code=new URL(await bridge.setup());
  const post=async(path,value={},origin=extensionOrigin,key=code.hash.slice(1))=>new Promise(resolve=>{
    const headers={};let status=200;
    const req={method:'POST',url:path,headers:{origin,host:'127.0.0.1:43001','x-1904-browser-key':key},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(value));}};
    const res={headersSent:false,setHeader:(name,value)=>{headers[name]=value;},writeHead:code=>{status=code;res.headersSent=true;},end:body=>resolve(new Response(body||'',{status,headers}))};
    f.handle()(req,res);
  });
  return {post};
}
test('browser preference defaults per device, validates and persists',()=>{
  const f=fixture();try{
    assert.equal(preference('broken'),'auto');assert.equal(f.bridge.state().preference,'auto');
    f.bridge.setPreference('cloud');assert.equal(f.bridge.state().preference,'cloud');
    assert.equal(JSON.parse(require('node:fs').readFileSync(join(f.dir,'prefs.json'))).preference,'cloud');
    assert.throws(()=>f.bridge.setPreference('other'),/preference/);
    assert.throws(()=>taskPath('../app',scope.taskId),/Invalid/);
    assert.throws(()=>publicOrigin('http://127.0.0.1'),/public/);
  }finally{f.close();}
});
test('only a paired extension can poll; native consent precedes exactly one server-issued operation',async()=>{
  const f=fixture();try{
    const {post}=await connection(f);
    assert.equal((await post('/poll',{},'https://evil.test')).status,403);
    assert.equal((await post('/poll',{},extensionOrigin,'0'.repeat(64))).status,403);
    assert.equal((await post('/share',{url:'https://example.com/account',browser:'Chrome'})).status,200);
    assert.equal(f.bridge.state().available,true);
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
