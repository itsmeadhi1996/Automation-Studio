import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {draftTest, McpConnections} from '../integrations.mjs';
import {queryExecutionOverview} from '../execution-overview.mjs';
import {createStudio} from './support.mjs';

const project={objects:[],globalVariables:{},environments:[]};
const cancelled=error=>error.code==='GENERATION_CANCELLED';

for(const provider of ['groq','google','openai']){
  test(`${provider} drafting propagates cancellation to an in-flight request`,async()=>{
    const controller=new AbortController();
    let requestSignal;
    await assert.rejects(draftTest({provider,model:'test',apiKey:'test-secret'},project,'Open the app',async(_,options)=>{
      requestSignal=options.signal;
      controller.abort();
      // Simulate a transport reacting to cancellation without a timed wait.
      requestSignal.throwIfAborted();
      throw new Error('Request was not cancelled');
    },{signal:controller.signal}),cancelled);
    assert.equal(requestSignal.aborted,true);
  });
}

test('already cancelled drafting does not discover tools or contact a provider',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(draftTest({provider:'groq',apiKey:'test-secret'},project,'Open',async()=>{calls++;},
    {signal:controller.signal,servers:[{}],connections:{list:async()=>{calls++;return {tools:[]};}}}),cancelled);
  assert.equal(calls,0);
});

test('cancellation during response parsing is reported consistently',async()=>{
  const controller=new AbortController();
  await assert.rejects(draftTest({provider:'groq',apiKey:'test-secret'},project,'Open',async()=>({
    ok:true,json:async()=>{controller.abort();throw new DOMException('Aborted','AbortError');}
  }),{signal:controller.signal}),cancelled);
});

test('cancelling MCP context stops subsequent tool calls and provider rounds',async()=>{
  const controller=new AbortController();let toolCalls=0,requests=0;
  const connections={
    list:async()=>({tools:[{name:'read',annotations:{readOnlyHint:true}}]}),
    call:async()=>{toolCalls++;controller.abort();return {content:[]};}
  };
  await assert.rejects(draftTest({provider:'groq',apiKey:'test-secret'},project,'Open',async()=>{
    requests++;
    return {ok:true,json:async()=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',
      tool_calls:[1,2].map(id=>({id:String(id),function:{name:'mcp_tool_1',arguments:'{}'}}))}}]})};
  },{signal:controller.signal,servers:[{name:'Context'}],connections}),cancelled);
  assert.equal(toolCalls,1);assert.equal(requests,1);
});

test('ordinary provider transport failures keep their original error',async()=>{
  const error=new Error('Connection unavailable');
  await assert.rejects(draftTest({provider:'groq',apiKey:'test-secret'},project,'Open',async()=>{throw error;},
    {signal:new AbortController().signal}),actual=>actual===error);
});

test('MCP cleanup detaches old connections before waiting and retains replacement connections',async()=>{
  const manager=new McpConnections();let release,oldClosed=0,newClosed=0;
  manager.clients.set('same',new Promise(resolve=>{release=resolve;}));
  const closing=manager.close();
  const replacement=Promise.resolve({close:async()=>{newClosed++;}});
  manager.clients.set('same',replacement);
  release({close:async()=>{oldClosed++;}});
  await closing;
  assert.equal(oldClosed,1);
  assert.equal(manager.clients.get('same'),replacement);
  await manager.close();
  assert.equal(newClosed,1);
  assert.equal(manager.clients.size,0);
});

test('execution date filters exclude unknown dates and include boundary dates',()=>{
  const runs=['invalid',undefined,'2026-01-01','2026-01-02','2026-01-03'].map((startedAt,i)=>({
    id:'run-'+i,startedAt,status:'passed',tests:[{id:'case',name:'Case',status:'passed',duration:10,steps:[]}]
  }));
  for(const filters of [{from:'2026-01-02'},{to:'2026-01-02'}]){
    const report=queryExecutionOverview(runs,new URLSearchParams(filters));
    assert.equal(report.total,2);assert.equal(report.summary.counts.passed,2);
  }
  const report=queryExecutionOverview(runs,new URLSearchParams({from:'2026-01-02',to:'2026-01-02',export:'csv'}));
  assert.deepEqual(report.rows.map(row=>row.runId),['run-3']);
  assert.equal(queryExecutionOverview(runs,new URLSearchParams()).total,5);
});

test('API rejects non-object JSON without creating projects or changing settings',async t=>{
  const port=3818,studio=await createStudio({port,storage:path.resolve('.test-output','review-'+Date.now())});
  t.after(()=>studio.close());await studio.listen();
  const before=JSON.stringify({projects:studio.store.projects,settings:studio.store.settings});
  for(const [route,method] of [['/api/projects','POST'],['/api/settings','PUT']]){
    for(const value of [null,[],true,42,'text']){
      const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/JSON object/);
    }
  }
  assert.equal(JSON.stringify({projects:studio.store.projects,settings:studio.store.settings}),before);
});
