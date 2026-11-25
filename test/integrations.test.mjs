import test from 'node:test';
import assert from 'node:assert/strict';
import { draftTest, normalizeIntegrationSettings, publicSettings } from '../integrations.mjs';
const groqSettings = {provider:'groq',model:'openai/gpt-oss-20b',apiKey:'groq-test-secret'};
test('AI MCP selections persist, redact credentials, and drop removed servers',()=>{
  const settings=normalizeIntegrationSettings({provider:'groq',apiKey:'secret',mcpServers:[{id:'playwright',name:'Playwright',transport:'http',url:'http://localhost:8931/mcp'}],aiMcpServerIds:['playwright']});
  assert.deepEqual(publicSettings(settings).aiMcpServerIds,['playwright']);
  assert.deepEqual(normalizeIntegrationSettings({model:'another-model'},settings).aiMcpServerIds,['playwright']);
  assert.deepEqual(normalizeIntegrationSettings({mcpServers:[]},settings).aiMcpServerIds,[]);
  assert.deepEqual(normalizeIntegrationSettings({aiMcpServerIds:[]},settings).aiMcpServerIds,[]);
  assert.throws(()=>normalizeIntegrationSettings({aiMcpServerIds:'playwright'},settings),/Select up to 10/);
  assert.equal(publicSettings(settings).apiKey,undefined);
});
const groqProject = {objects:[],globalVariables:{PASSWORD:'private-password'},environments:[{id:'dev',variables:{BASE_URL:'private-url'}}],activeEnvironmentId:'dev'};
const groqDraft = {name:'Login',explanation:'Verify selectors',steps:[{name:'Open',action:'navigate',target:'',locatorType:'css',replacement:'',value:'BASE_URL',valueMode:'environment'}]};
const groqResponse = (message={role:'assistant',content:JSON.stringify(groqDraft)},finish_reason='stop')=>({ok:true,json:async()=>({choices:[{finish_reason,message}]})});
test('Groq uses strict structured output and excludes secrets from prompts',async()=>{
  const draft=await draftTest(groqSettings,groqProject,'Open BASE_URL',async(url,options)=>{
    assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer groq-test-secret');
    const body=JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.tools,undefined);
    assert.doesNotMatch(options.body,/private-password|private-url|groq-test-secret/);
    return groqResponse();
  });
  assert.equal(draft.steps[0].value,'BASE_URL');
});
test('Groq keeps provider keys separate and supports switching back',()=>{
  const google=normalizeIntegrationSettings({provider:'google',apiKey:'google-secret'});
  const groq=normalizeIntegrationSettings({provider:'groq',apiKey:'groq-secret'},google);
  assert.equal(groq.model,'openai/gpt-oss-20b');
  assert.equal(groq.apiKeys.google,'google-secret');
  assert.equal(normalizeIntegrationSettings({provider:'google'},groq).apiKey,'google-secret');
  assert.equal(normalizeIntegrationSettings({clearApiKey:true},groq).apiKey,'');
  assert.doesNotMatch(JSON.stringify(publicSettings(groq)),/secret|apiKeys/);
});
test('NVIDIA drafts through its chat completions API and extracts fenced JSON',async()=>{
  const settings=normalizeIntegrationSettings({provider:'nvidia',apiKey:'nvapi-test-secret'});
  assert.equal(settings.model,'meta/muse-glimmer-30b');
  const reply=`<think>planning</think>Here is the draft:\n\`\`\`json\n${JSON.stringify(groqDraft)}\n\`\`\``;
  const draft=await draftTest(settings,groqProject,'Open BASE_URL',async(url,options)=>{
    assert.equal(url,'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer nvapi-test-secret');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'meta/muse-glimmer-30b');
    assert.equal(body.max_tokens,8192);
    assert.equal(body.response_format,undefined);
    assert.match(body.messages[0].content,/Return JSON matching this schema/);
    assert.doesNotMatch(options.body,/private-password|private-url|nvapi-test-secret/);
    return groqResponse({role:'assistant',content:reply});
  });
  assert.equal(draft.name,'Login');
  assert.equal(draft.steps[0].value,'BASE_URL');
  await assert.rejects(draftTest(settings,groqProject,'Open',async()=>({ok:false,status:401,json:async()=>({detail:'Unauthorized'})})),/NVIDIA API key is invalid/);
});
test('NVIDIA retries one empty gateway response, then reports it clearly',async()=>{
  const settings=normalizeIntegrationSettings({provider:'nvidia',apiKey:'nvapi-test-secret'});
  const empty=()=>({ok:false,status:504,json:async()=>JSON.parse('')});
  let calls=0;
  const draft=await draftTest(settings,groqProject,'Open BASE_URL',async()=>(++calls===1?empty():groqResponse()));
  assert.equal(calls,2);
  assert.equal(draft.name,'Login');
  await assert.rejects(draftTest(settings,groqProject,'Open',async()=>empty()),/NVIDIA returned an empty or unreadable response \(HTTP 504\) twice/);
});

const malformedGroqCall =() => ({ok:false,status:400,json:async()=>({error:{code:'tool_use_failed',message:'Failed to parse tool call arguments as JSON',failed_generation:'DO_NOT_EXECUTE_OR_REPLAY'}})});
const propertyPrompt = 'Open https://brosapp.ebita.ai/\nEnter kakkanad in search field\nAnd click search\nVerify 3 BHK Villa for Sale in Kakkanad is displayed in the result page\nOpen the details screen of the 3 BHK Villa for Sale in Kakkanad by clicking the View Details button\nVerify the property name is shown as 3 BHK Villa for Sale in Kakkanad';

test('Groq recovers provider tool parsing errors even when no tools were requested',async()=>{
  let requests=0;
  const draft=await draftTest(groqSettings,groqProject,propertyPrompt,async(url,options)=>{
    const body=JSON.parse(options.body);requests++;
    assert.equal(body.tools,undefined);assert.equal(body.response_format.json_schema.strict,true);
    assert.match(body.messages[0].content,/No tools are available/);
    assert.doesNotMatch(body.messages[0].content,/You may call/);
    assert.match(body.messages[1].content,/kakkanad/);
    assert.match(body.messages[1].content,/observed-search/);
    assert.doesNotMatch(options.body,/DO_NOT_EXECUTE_OR_REPLAY/);
    return requests===1?malformedGroqCall():groqResponse();
  },{inspection:{elements:[{target:'observed-search'}]}});
  assert.equal(requests,2);assert.equal(draft.name,'Login');
});

test('Groq recovery preserves completed MCP context and discloses interrupted inspection',async()=>{
  let requests=0,calls=0;
  const connections={list:async()=>({tools:[{name:'inspect',annotations:{readOnlyHint:true}}]}),call:async()=>{calls++;return{content:[{type:'text',text:'Observed property search'}]};}};
  const draft=await draftTest(groqSettings,groqProject,propertyPrompt,async(url,options)=>{
    const body=JSON.parse(options.body);requests++;
    if(requests===1)return groqResponse({role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'mcp_tool_1',arguments:'{}'}}]},'tool_calls');
    if(requests===2)return malformedGroqCall();
    assert.equal(body.tools,undefined);assert.equal(body.response_format.json_schema.strict,true);
    assert.ok(body.messages.every(m=>!m.tool_calls&&m.role!=='tool'));
    assert.match(options.body,/Observed property search/);assert.doesNotMatch(options.body,/DO_NOT_EXECUTE_OR_REPLAY/);
    return groqResponse();
  },{connections,servers:[{name:'Docs'}]});
  assert.equal(requests,3);assert.equal(calls,1);assert.match(draft.explanation,/context gathering was interrupted/);
});

test('Groq retries invalid JSON once, and bounds repeated provider parsing failures',async()=>{
  for(const failure of [malformedGroqCall,()=>groqResponse({role:'assistant',content:'{broken'})]){
    let requests=0;
    await assert.rejects(draftTest(groqSettings,groqProject,propertyPrompt,async()=>{requests++;return failure();}),/after an automatic retry/);
    assert.equal(requests,2);
  }
  let requests=0;
  const draft=await draftTest(groqSettings,groqProject,propertyPrompt,async()=>++requests===1?groqResponse({role:'assistant',content:'{broken'}):groqResponse());
  assert.equal(requests,2);assert.equal(draft.name,'Login');
});

test('Groq does not retry unrelated API errors',async()=>{
  let requests=0;
  await assert.rejects(draftTest(groqSettings,groqProject,propertyPrompt,async()=>{requests++;return{ok:false,status:400,json:async()=>({error:{message:'Unsupported model'}})};}),/Unsupported model/);
  assert.equal(requests,1);
});
test('Groq gathers read-only MCP context before requesting structured output',async()=>{
  const requests=[],calls=[];
  const connections={list:async()=>({tools:[{name:'inspect',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}},{name:'write',annotations:{readOnlyHint:false}}]}),call:async(...args)=>{calls.push(args);return{content:[{type:'text',text:'Submit button'}]};}};
  await draftTest(groqSettings,groqProject,'Inspect and draft',async(url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(requests.length===1){assert.equal(body.tools.length,1);assert.equal(body.response_format,undefined);return groqResponse({role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'mcp_tool_1',arguments:'{}'}}]},'tool_calls');}
    if(requests.length===2){assert.equal(body.messages.at(-1).tool_call_id,'call_1');return groqResponse({role:'assistant',content:'Ready to draft'});}
    assert.equal(body.tools,undefined);assert.equal(body.response_format.json_schema.strict,true);return groqResponse();
  },{connections,servers:[{name:'Docs'}]});
  assert.equal(calls.length,1);assert.equal(calls[0][1],'inspect');assert.equal(requests.length,3);
});
test('Groq rejects incomplete drafts, unknown tools, authentication and quota errors',async()=>{
  await assert.rejects(draftTest(groqSettings,groqProject,'Draft',async()=>groqResponse(undefined,'length')),/Groq response length/);
  for(const [status,code] of [[401,'GROQ_API_KEY_INVALID'],[429,'GROQ_QUOTA_EXCEEDED']]){
    await assert.rejects(draftTest(groqSettings,groqProject,'Draft',async()=>({ok:false,status,json:async()=>({error:{message:'Rejected'}})})),{code});
  }
  let called=false;
  await assert.rejects(draftTest(groqSettings,groqProject,'Draft',async()=>groqResponse({role:'assistant',tool_calls:[{id:'bad',function:{name:'unknown',arguments:'{}'}}]},'tool_calls'),{connections:{list:async()=>({tools:[{name:'inspect',annotations:{readOnlyHint:true}}]}),call:async()=>{called=true;}},servers:[{name:'Docs'}]}),/not enabled/);
  assert.equal(called,false);
});
test('Gemini array errors explain invalid keys and preserve provider diagnostics',async()=>{
  const settings={provider:'google',apiKey:'test-secret',model:'gemini-3.8-flash'};
  const project={objects:[],globalVariables:{},environments:[]};
  const failure=(error,status=400)=>async()=>({ok:false,status,statusText:'Bad Request',json:async()=>[{error}]});
  await assert.rejects(draftTest(settings,project,'Draft',failure({message:'API key not valid. Please pass a valid API key.',details:[{reason:'API_KEY_INVALID'}]})),{code:'GEMINI_API_KEY_INVALID',status:400,message:'Gemini API key is invalid or expired. Create a new key in Google AI Studio, then save it in Model settings.'});
  await assert.rejects(draftTest(settings,project,'Draft',failure({message:'Quota exceeded',status:'RESOURCE_EXHAUSTED'},429)),{code:'GEMINI_QUOTA_EXCEEDED',status:429});
  await assert.rejects(draftTest(settings,project,'Draft',failure({message:'Unsupported model for test-secret'})),{message:'Gemini: Unsupported model for [REDACTED]'});
});
test('OpenAI drafting uses structured output and excludes variable values and credentials',async()=>{
  let request;
  const fetcher=async(url,options)=>{request={url,...options,body:JSON.parse(options.body)};return{ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({name:'Draft',explanation:'Verify selectors',steps:[{action:'navigate',value:'BASE_URL',valueMode:'environment'}]})}]}]})};};
  const project={objects:[],globalVariables:{PASSWORD:'secret-one'},environments:[{id:'local',variables:{BASE_URL:'secret-two'}}],activeEnvironmentId:'local',jdbcProfiles:[{password:'secret-three'}]};
  const draft=await draftTest({apiKey:'test-key',model:'test-model'},project,'Open the home page',fetcher);
  assert.equal(draft.steps[0].value,'BASE_URL');assert.equal(request.body.text.format.strict,true);assert.equal(request.body.store,false);assert.equal(request.url,'https://api.openai.com/v1/responses');
  assert.doesNotMatch(JSON.stringify(request.body),/secret-one|secret-two|secret-three/);
  assert.match(request.body.input,/PASSWORD/);
});
test('OpenAI errors and incomplete responses do not become test drafts',async()=>{
  const p={objects:[],globalVariables:{},environments:[]};
  await assert.rejects(draftTest({apiKey:'test-api-key',model:'model'},p,'Draft',async()=>({ok:false,json:async()=>({error:{message:'Invalid key'}})})),/Invalid key/);
  await assert.rejects(draftTest({apiKey:'key',model:'model'},p,'Draft',async()=>({ok:true,json:async()=>({status:'incomplete'})})),/incomplete/);
});
test('connection settings redact keys and validate executable arguments',()=>{
  const s=normalizeIntegrationSettings({model:'model',apiKey:'secret',mcpServers:[{name:'Local',transport:'stdio',command:'node',args:['server.mjs']}]});
  assert.equal(publicSettings(s).apiKey,undefined);assert.equal(publicSettings(s).hasApiKey,true);
  assert.equal(normalizeIntegrationSettings({apiKey:''},s).apiKey,'secret');
  assert.equal(normalizeIntegrationSettings({clearApiKey:true},s).apiKey,'');
  assert.throws(()=>normalizeIntegrationSettings({mcpServers:[{name:'bad',transport:'stdio',command:'node',args:'server.mjs'}]}),/Arguments/);
});
