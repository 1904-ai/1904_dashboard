const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
function fixture({tabUrl='https://example.com/account',connected=true}={}){
  const calls=[],listeners={};
  const event=name=>({addListener:fn=>{listeners[name]=fn;}});
  const context=vm.createContext({URL,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,AbortSignal,navigator:{userAgent:'Chrome'},
    chrome:{runtime:{id:'a'.repeat(32),getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path,onMessage:event('message')},
      storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
      tabs:{get:async()=>({url:tabUrl}),onRemoved:event('removed')},
      debugger:{attach:async()=>{},detach:async()=>{},onEvent:event('event'),onDetach:event('detach'),sendCommand:async(target,method,params)=>{
        calls.push({target,method,params});
        if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};
        if(method==='Page.createIsolatedWorld')return {executionContextId:7};
        if(method==='Runtime.evaluate')return {result:{value:{url:tabUrl,title:'Account',tree:'page',hashInput:'private form values'}}};
        if(method==='Page.captureScreenshot')return {data:'ZnJhbWU='};return {};
      }},
    },
  });
  vm.runInContext(readFileSync(join(__dirname,'../browser-extension/worker.js'),'utf8'),context);
  if(connected)vm.runInContext("connection={origin:'http://127.0.0.1:43001',key:'test'};tabId=12;site='https://example.com';attached=true;",context);
  return {context,calls,listeners,run:code=>vm.runInContext(code,context)};
}
test('extension observes only the selected tab and hashes form state before transfer',async()=>{
  const f=fixture();const result=await f.run("execute({operation:'observe',expiresAt:Date.now()+10000})");
  assert.equal(result.title,'Account');assert.match(result.fingerprint,/^[a-f0-9]{64}$/);assert.equal(result.hashInput,undefined);
  assert.ok(f.calls.every(call=>call.target.tabId===12));
  assert.ok(f.calls.some(call=>call.method==='Page.createIsolatedWorld'));
  assert.ok(!f.calls.some(call=>/^Network\.|Storage\./.test(call.method)),'no credential or cookie API');
});
test('extension rejects expired work, arbitrary CDP and cross-site navigation before dispatch',async()=>{
  const f=fixture();
  await assert.rejects(f.run("execute({operation:'action',expiresAt:1,payload:{action:{action:'click'}}})"),/expired/);
  await assert.rejects(f.run("execute({operation:'Network.getAllCookies',expiresAt:Date.now()+10000,payload:{}})"),/Unsupported/);
  await assert.rejects(f.run("execute({operation:'navigate',expiresAt:Date.now()+10000,payload:{url:'https://other.example.com'}})"),/destination/);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.run("key('Control+L')"),/Unsupported|shortcuts/);
});
test('cross-site main-frame requests are blocked before navigation, and popup messages are scoped',async()=>{
  const f=fixture();
  f.listeners.event({tabId:12},'Fetch.requestPaused',{requestId:'navigation',request:{url:'http://127.0.0.1/admin'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls[0].method,'Fetch.failRequest');
  let replied=false;
  assert.equal(f.listeners.message({operation:'share'},{id:'different',url:'https://evil.test'},()=>{replied=true;}),undefined);
  assert.equal(replied,false);
});
test('extension accepts non-URL 1904 pairing codes, reports status, and surfaces clear validation errors',async()=>{
  const f=fixture({connected:false});
  const token='c'.repeat(64);
  const posted=[];
  f.context.fetch=async(url,init)=>{
    const path=new URL(url).pathname;
    posted.push({url,path,key:init.headers['x-1904-browser-key']});
    if(path==='/share')return Response.json({});
    throw new Error('stop loop');
  };
  const sender={id:'a'.repeat(32),url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'};
  const ask=msg=>new Promise(resolve=>f.listeners.message(msg,sender,resolve));

  const badCode=await ask({operation:'share',code:'not-a-code',tabId:5});
  assert.equal(badCode.ok,false);
  assert.match(badCode.error,/starts with 1904-/);

  const shared=await ask({operation:'share',code:`  1904-43001-${token}  `,tabId:5});
  assert.equal(shared.ok,true);
  assert.equal(shared.site,'https://example.com');
  assert.equal(posted[0].url,'http://127.0.0.1:43001/share');
  assert.equal(posted[0].key,token);

  const legacy=await f.run(`parsePairingCode(${JSON.stringify(`http://127.0.0.1:43001/#${token}`)})`);
  assert.equal(legacy.origin,'http://127.0.0.1:43001');
  assert.equal(legacy.key,token);

  const nonPublic=fixture({tabUrl:'chrome://extensions',connected:false});
  const nonPublicAnswer=await new Promise(resolve=>nonPublic.listeners.message({operation:'share',code:`1904-43001-${token}`,tabId:5},sender,resolve));
  assert.equal(nonPublicAnswer.ok,false);
  assert.match(nonPublicAnswer.error,/public website tab/);

  const connectedFixture=fixture({connected:true});
  const status=await new Promise(resolve=>connectedFixture.listeners.message({operation:'status'},sender,resolve));
  assert.deepEqual({...status},{ok:true,connected:true,site:'https://example.com'});
});
test('extension manifest limits host access to the loopback connector and includes README guidance',()=>{
  const manifest=JSON.parse(readFileSync(join(__dirname,'../browser-extension/manifest.json'),'utf8'));
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1/*']);
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.externally_connectable);
  const readme=readFileSync(join(__dirname,'../browser-extension/README.txt'),'utf8');
  assert.match(readme,/Load unpacked/);
  assert.match(readme,/1904-browser-extension/);
});
test('extension shares its tab again when Desktop asks after sleep',async()=>{
  const f=fixture();const posts=[];let polls=0;
  f.context.fetch=async(url,init)=>{const path=new URL(url).pathname;posts.push(path);
    if(path==='/poll'){polls++;if(polls===1)return Response.json({release:true,reshare:true});throw new Error('Desktop closed');}
    return Response.json({});};
  await f.run('loop()');
  assert.deepEqual(posts.slice(0,2),['/poll','/share']);
  assert.ok(f.calls.some(call=>call.method==='Page.enable'),'the tab is attached again before sharing');
});
