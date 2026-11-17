const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
function fixture(){
  const calls=[],listeners={};
  const event=name=>({addListener:fn=>{listeners[name]=fn;}});
  const context=vm.createContext({URL,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,AbortSignal,navigator:{userAgent:'Chrome'},
    chrome:{runtime:{id:'a'.repeat(32),getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path,onMessage:event('message')},
      storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
      tabs:{get:async()=>({url:'https://example.com/account'}),onRemoved:event('removed')},
      debugger:{attach:async()=>{},detach:async()=>{},onEvent:event('event'),onDetach:event('detach'),sendCommand:async(target,method,params)=>{
        calls.push({target,method,params});
        if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};
        if(method==='Page.createIsolatedWorld')return {executionContextId:7};
        if(method==='Runtime.evaluate')return {result:{value:{url:'https://example.com/account',title:'Account',tree:'page',hashInput:'private form values'}}};
        if(method==='Page.captureScreenshot')return {data:'ZnJhbWU='};return {};
      }},
    },
  });
  vm.runInContext(readFileSync(join(__dirname,'../browser-extension/worker.js'),'utf8'),context);
  vm.runInContext("connection={origin:'http://127.0.0.1:43001',key:'test'};tabId=12;site='https://example.com';attached=true;",context);
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

test('extension manifest limits host access to the loopback connector',()=>{
  const manifest=JSON.parse(readFileSync(join(__dirname,'../browser-extension/manifest.json'),'utf8'));
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1/*']);
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.externally_connectable);
});
