import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { inspectionUrl, validateGeneratedTest } from '../inspection.mjs';
import { locator } from '../runner.mjs';
import { launchBrowser } from '../browsers.mjs';

for (const provider of ['groq', 'reasonx']) test(`${provider} corrects login locators using inspected controls and preserves environment references`, {timeout:90000}, async t => {
  let submissions = 0;
  const fixture = http.createServer((req,res) => {
    res.setHeader('Content-Type','text/html');
    if (req.url === '/dashboard') { submissions++; return res.end('<h6>Dashboard</h6>'); }
    // Visible captions without label associations, like many component forms.
    res.end('<title>Login fixture</title><form action="/dashboard"><label>Username</label><input name="username" placeholder="Username"><label>Password</label><input name="password" type="password" placeholder="Password"><button type="submit">Login</button></form>');
  });
  await new Promise(resolve => fixture.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const loginUrl = `http://127.0.0.1:${fixture.address().port}/login`;
  let requests = 0, alwaysInvalid = false, useObserved = false;
  const studio = await createStudio({port:provider === 'groq' ? 3396 : 3397,storage:path.resolve('.test-output',`login-authoring-${provider}-${Date.now()}`),aiFetcher:async(url,options) => {
    requests++;
    const body = JSON.parse(options.body), input = body.messages.at(-1).content;
    const correcting = input.includes('Studio validation feedback:') || input.includes('validationFeedback');
    assert.doesNotMatch(options.body,/fixture-user-secret|fixture-password-secret/);
    if (requests === 2) {
      assert.ok(correcting);
      assert.match(input,/Step 2/);
      assert.match(input,/Correct ALL initial-page locators/);
    }
    const valid = (correcting || useObserved) && !alwaysInvalid;
    const steps = [
      {action:'navigate',value:loginUrl},
      {action:'fill',locatorType:valid?'placeholder':'label',target:'Username',value:'Username',valueMode:'environment'},
      {action:'fill',locatorType:valid?'placeholder':'label',target:'Password',value:'Password',valueMode:'environment'},
      {action:'click',locatorType:'text',target:valid?'Login':'Sign in'},
      {action:'visible',locatorType:'text',target:'Dashboard'}
    ].map(step => ({name:'Generated action',locatorType:'css',target:'',replacement:'',value:'',valueMode:'static',framePath:[],...step}));
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({name:'Login test',explanation:'Review Dashboard after login.',steps})}}]})};
  }});
  t.after(() => studio.close());
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  const api = async(route,body) => {
    const response = await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  studio.store.settings = {...studio.store.settings,provider,apiKey:'mock-key',apiKeys:{[provider]:'mock-key'}};
  const project = studio.store.projects[0];
  project.environments.find(env => env.id === project.activeEnvironmentId).variables = {Username:'fixture-user-secret',Password:'fixture-password-secret'};
  const prompt = `Open the sign-in page at ${loginUrl}. Fill the Username and Password fields using environment variables Username and Password. Click Sign in, then check that the Dashboard heading is visible.`;
  const before = project.tests.length;
  const result = await api('/api/ai/create',{projectId:project.id,prompt});
  assert.equal(result.status,201,JSON.stringify(result.data));
  assert.equal(requests,2);
  assert.equal(result.data.status,'not_run');
  assert.equal(result.data.warnings.length,1);
  assert.match(result.data.warnings[0],/Step 5.*later page/);
  assert.equal(studio.store.runs.length,0);
  assert.equal(submissions,0);
  const saved = studio.store.projects[0];
  assert.equal(saved.tests.length,before+1);
  const steps = saved.tests.at(-1).steps;
  assert.equal(steps[1].value,'Username'); assert.equal(steps[1].valueMode,'environment');
  assert.equal(steps[2].value,'Password'); assert.equal(steps[2].valueMode,'environment');
  const browser = await launchBrowser(); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(loginUrl);
  assert.equal(await page.getByLabel('Username',{exact:true}).count(),0);
  for (const step of steps.slice(1,4)) assert.equal(await locator(page,step,saved.objects,saved.locatorTemplates).count(),1);
  // A model that ignores feedback must still fail without saving a partial case.
  alwaysInvalid = true;
  const rejected = await api('/api/ai/create',{projectId:project.id,prompt});
  assert.equal(rejected.status,400);
  assert.match(rejected.data.error,/Step 2.*not observed/);
  assert.equal(requests,4);
  assert.equal(studio.store.projects[0].tests.length,before+1);
  assert.equal(submissions,0);
  // Missing credentials are actionable configuration errors, not model retries.
  delete studio.store.projects[0].environments.find(env => env.id === project.activeEnvironmentId).variables.Password;
  alwaysInvalid = false;
  useObserved = true;
  const missing = await api('/api/ai/create',{projectId:project.id,prompt});
  assert.equal(missing.status,400);
  assert.match(missing.data.error,/set Password/);
  assert.equal(requests,5);
});

test('AI inspects through MCP, saves an executable case, and waits for a manual run',{timeout:90000},async t=>{
  const port=3223,base=`http://127.0.0.1:${port}`;
  let requests=0;
  const studio=await createStudio({port,storage:path.resolve('.test-output',`authoring-${Date.now()}`),aiFetcher:async(url,options)=>{
    requests++;
    const body=JSON.parse(options.body),prompt=JSON.stringify(body.messages);
    assert.match(prompt,/studio_inspect_page/);assert.match(prompt,/Get started/);assert.match(prompt,/"?matched/);
    assert.doesNotMatch(prompt,/credential-value/);
    const steps=[
      {name:'Open',action:'navigate',value:'BASE_URL',valueMode:'environment'},
      {name:'Enter name',action:'fill',locatorType:'id',target:'name',value:'Alex'},
      {name:'Submit',action:'click',locatorType:'text',target:'Get started'},
      {name:'Check welcome',action:'text',locatorType:'id',target:'message',value:'Welcome, Alex!'}
    ].map(s=>({framePath:[],locatorType:'css',target:'',replacement:'',value:'',valueMode:'static',...s}));
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({name:'Generated welcome',explanation:'Uses inspected name and submit controls. Verify the later welcome message.',steps})}}]})};
  }});
  await studio.listen();
  let browser;t.after(async()=>{await browser?.close();await studio.close();});
  const api=async(route,method='GET',body)=>{
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const project=studio.store.projects[0];project.globalVariables.PASSWORD='credential-value';
  await api('/api/settings','PUT',{provider:'groq',apiKey:'mock-key'});
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation');await page.getByRole('button',{name:'AI Assistance'}).click();
  await page.locator('#ai-prompt').fill('Open BASE_URL, enter Alex into Your name, click Get started, and verify Welcome, Alex!');
  await page.getByRole('button',{name:'Generate test',exact:false}).click();
  await page.getByRole('button',{name:'Open test editor'}).waitFor({timeout:30000});
  const saved=(await api('/api/state')).data;
  assert.equal(requests,1);assert.equal(saved.projects[0].tests.length,2);assert.equal(saved.projects[0].tests[1].tcNumber,2);assert.equal(saved.runs.length,0);assert.deepEqual(saved.projects[0].tests[1].steps[1].framePath,[]);
  await page.getByRole('button',{name:'Open test editor'}).click();
  await page.getByRole('heading',{name:'Generated welcome',exact:true}).waitFor();
  await page.locator('.tabs [data-view="cases"]').click();
  await page.getByRole('checkbox',{name:'Select Generated welcome',exact:true}).check();
  await page.getByRole('button',{name:'Run Generated welcome',exact:true}).click();
  let completed;
  for(let i=0;i<200;i++) { completed=(await api('/api/state')).data; if(completed.runs.length && completed.runs[0].status!=='running')break;await new Promise(resolve=>setTimeout(resolve,100)); }
  assert.equal(completed.runs[0].status,'passed',JSON.stringify(completed.runs[0]));
  const invalid=await api(`/api/projects/${project.id}/tests`,'POST',{name:'Missing password',steps:[{action:'fill',target:'password',value:'MISSING_PASSWORD',valueMode:'environment'}]});
  assert.equal(invalid.status,400);assert.match(invalid.data.error,/MISSING_PASSWORD/);
  assert.equal(studio.store.projects[0].tests.length,2);assert.equal(studio.store.nextTestNumber,3);
  const rejected=await api('/api/ai/create','POST',{projectId:project.id,prompt:'Open file:///etc/passwd',mcpServerIds:['unknown']});
  assert.equal(rejected.status,400);assert.equal(requests,1);assert.deepEqual(errors,[]);
});

test('authoring requires usable URLs, variable values and observed initial-page controls',()=>{
  const project={globalVariables:{},environments:[],objects:[]};
  assert.throws(()=>inspectionUrl(project),/BASE_URL/);
  assert.throws(()=>inspectionUrl(project,'file:///test'),/HTTP/);
  assert.throws(()=>inspectionUrl(project,'https://user:password@example.com'),/credentials/);
  assert.throws(()=>validateGeneratedTest(project,{steps:[]}),/no test steps/);
  assert.throws(()=>validateGeneratedTest(project,{steps:[{action:'navigate',value:'',valueMode:'static',target:''}]}),/URL is required/);
  assert.throws(()=>validateGeneratedTest(project,{steps:[{action:'navigate',value:'https://example.com',valueMode:'static',target:''},{action:'fill',locatorType:'id',target:'invented',value:'A',valueMode:'static'}]},{elements:[]}),/not observed/);
  assert.throws(()=>validateGeneratedTest(project,{steps:[{action:'navigate',value:'https://example.com',valueMode:'static',target:''},{action:'url',value:'login page',valueMode:'static',target:''}]}),e=>e.code==='GENERATED_URL_INVALID'&&/^Step 2: the URL check needs a full HTTP or HTTPS address/.test(e.message));
});

test('a generated partial URL is corrected once from feedback before anything is saved',{timeout:60000},async t=>{
  const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Login</title><input placeholder="Username"><button>Login</button><h3>Epic sadface: Sorry, this user has been locked out.</h3>');});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>fixture.close(resolve)));
  const loginUrl=`http://127.0.0.1:${fixture.address().port}/`;
  let requests=0,feedback='';
  const studio=await createStudio({port:3399,storage:path.resolve('.test-output',`url-correction-${Date.now()}`),aiFetcher:async(url,options)=>{
    requests++;const input=JSON.parse(options.body).messages.at(-1).content;if(requests===2)feedback=input;
    const steps=[{action:'navigate',value:loginUrl},{action:'url',value:requests===1?'login page':loginUrl},{action:'text',locatorType:'text',target:'Epic sadface: Sorry, this user has been locked out.',value:'Epic sadface: Sorry, this user has been locked out.'}]
      .map(step=>({name:'Generated action',locatorType:'css',target:'',replacement:'',value:'',valueMode:'static',framePath:[],...step}));
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({name:'Locked out',explanation:'Draft',steps})}}]})};
  }});
  t.after(()=>studio.close());await studio.listen();
  studio.store.settings={...studio.store.settings,provider:'groq',apiKey:'mock-key',apiKeys:{groq:'mock-key'}};
  const project=studio.store.projects[0],before=project.tests.length;
  const response=await fetch(`http://127.0.0.1:${studio.server.address().port}/api/ai/create`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,prompt:`User is on ${loginUrl} login page.\n1. Verify the error message: 'Epic sadface: Sorry, this user has been locked out.'`})});
  const result=await response.json();
  assert.equal(response.status,201,JSON.stringify(result));assert.equal(requests,2);
  assert.match(feedback,/Step 2: the URL check needs a full HTTP or HTTPS address/);assert.ok(feedback.includes('Begin with navigate to '+loginUrl));
  assert.equal(studio.store.projects[0].tests.length,before+1);assert.equal(studio.store.projects[0].tests.at(-1).steps[1].value,loginUrl);assert.equal(studio.store.runs.length,0);
});
