import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { normalizeProject, prepareRun, sampleProject } from '../model.mjs';
import { normalizeQa } from '../qa-model.mjs';
import { preflight } from '../runner.mjs';

const manualCase = () => ({id:'manual',inTestPlan:true,name:'Verify account access',steps:[],qa:{description:'An account can sign in',priority:'high',type:'security',owner:'QA tester',preconditions:'An active test account',executionMode:'manual',manualSteps:[{id:'one',instruction:'Open the sign-in page',expectedResult:'The form is visible'},{id:'two',instruction:'Submit valid credentials',expectedResult:'The dashboard appears'}]}});
const makeApi = base => async(route,method='GET',body) => {const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};

test('QA fields survive automation saves; selections and manual-only cases are validated',()=>{
 const store={nextTestNumber:1},raw=sampleProject(3200);raw.tests.push(manualCase());let p=normalizeProject(raw,null,store);
 const input=structuredClone(p);delete input.tests[1].qa;input.tests[1].steps=[{action:'wait',value:'0'}];p=normalizeProject(input,p,store);
 assert.equal(p.tests[1].qa.manualSteps[1].expectedResult,'The dashboard appears');assert.equal(p.tests[1].qa.priority,'high');assert.equal(p.tests[1].tcNumber,2);
 assert.equal(prepareRun(p,{testIds:['manual']}).tests.length,1);assert.throws(()=>prepareRun(p,{testIds:['missing']}),/existing/);
 p.tests[1].steps=[];assert.equal(preflight(p,{testId:'manual'}).ok,false);
 assert.throws(()=>normalizeQa({priority:'urgent'}),/priority/);
 assert.throws(()=>normalizeQa({manualSteps:[{instruction:''}]}),/instruction/);
 assert.throws(()=>normalizeQa({manualSteps:[{id:'x',instruction:'A'},{id:'x',instruction:'B'}]}),/unique/);
});

test('manual results are revisioned, durable snapshots with escaped reports and explicit completion',{timeout:30000},async t=>{
 const port=3260,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`qa-api-${Date.now()}`);let studio=await createStudio({port,storage});await studio.listen();t.after(()=>studio.close());const api=makeApi(base);
 let p=(await api('/api/projects','POST',{name:'QA lifecycle',tests:[manualCase()]})).data;
 let result=await api('/api/runs','POST',{projectId:p.id,testId:'manual'});assert.equal(result.status,400);assert.match(result.data.error,/configure automation/);
 result=await api('/api/manual-runs','POST',{projectId:p.id,testIds:['missing']});assert.equal(result.status,400);
 let r=(await api('/api/manual-runs','POST',{projectId:p.id,testIds:['manual'],name:'Release verification'})).data;
 assert.equal(r.status,'running');assert.equal(r.mode,'manual');assert.equal(r.tests[0].steps.length,2);
 assert.equal((await api(`/api/manual-runs/${r.id}/complete`,'POST',{revision:r.revision})).status,400);
 assert.equal((await api(`/api/runs/${r.id}`,'DELETE')).status,409);
 result=await api(`/api/manual-runs/${r.id}/steps`,'PUT',{revision:r.revision,testId:'manual',stepIndex:0,status:'passed',actualResult:'<script>never execute</script>'});assert.equal(result.status,200);r=result.data;
 const stale=await api(`/api/manual-runs/${r.id}/steps`,'PUT',{revision:1,testId:'manual',stepIndex:1,status:'passed'});assert.equal(stale.status,409);assert.equal(stale.data.code,'EDIT_CONFLICT');
 p.tests[0].qa.manualSteps[0].instruction='Changed after execution';p=(await api(`/api/projects/${p.id}`,'PUT',p)).data;assert.equal((await api(`/api/runs/${r.id}`)).data.tests[0].steps[0].name,'Open the sign-in page');
 // Active manual runs survive server restarts, unlike browser sessions.
 await studio.close();studio=await createStudio({port,storage});await studio.listen();r=(await api(`/api/runs/${r.id}`)).data;assert.equal(r.status,'running');assert.equal(r.tests[0].steps[0].status,'passed');
 r=(await api(`/api/manual-runs/${r.id}/steps`,'PUT',{revision:r.revision,testId:'manual',stepIndex:1,status:'blocked',actualResult:'Account unavailable'})).data;
 r=(await api(`/api/manual-runs/${r.id}/complete`,'POST',{revision:r.revision})).data;assert.equal(r.status,'blocked');assert.ok(r.finishedAt);assert.ok(r.duration>=0);
 assert.equal((await api(`/api/manual-runs/${r.id}/steps`,'PUT',{revision:r.revision,testId:'manual',stepIndex:0,status:'failed'})).status,409);
 const report=await(await fetch(base+`/api/runs/${r.id}/report`)).text();assert.match(report,/&lt;script&gt;never execute/);assert.doesNotMatch(report,/<script>never execute/);assert.match(report,/Account unavailable/);assert.match(report,/The form is visible/);assert.match(report,/Manual execution/);
 let active=(await api('/api/manual-runs','POST',{projectId:p.id,testId:'manual'})).data;
 await api('/api/history/retain','POST',{keep:1});assert.equal((await api(`/api/runs/${active.id}`)).data.status,'running');
 active=(await api(`/api/manual-runs/${active.id}/cancel`,'POST',{revision:active.revision})).data;assert.equal(active.status,'interrupted');assert.ok(active.tests[0].steps.every(s=>s.status==='skipped'));
});

test('QA browser flow: create, filter, execute manually, transfer, automate and report',{timeout:120000},async t=>{
 const port=3261,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`qa-browser-${Date.now()}`);const studio=await createStudio({port,storage});await studio.listen();let browser;t.after(async()=>{await browser?.close();await studio.close();});const api=makeApi(base);
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
 await page.goto(base);await page.getByRole('heading',{name:'Project overview'}).waitFor();
 for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overview overflow ${width}`);}
 await page.screenshot({path:path.join(storage,'qa-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Create test case',exact:true}).click();
 await page.getByLabel('Test case title').fill('Verify profile details');await page.getByLabel('Description',{exact:true}).fill('Profile data is visible and editable.');await page.getByLabel('Priority',{exact:true}).selectOption('high');await page.getByLabel('Assignee').fill('Sam Taylor');
 await page.getByRole('textbox',{name:'Preconditions',exact:true}).fill('A signed-in user');await page.getByLabel('Action / instruction').fill('Open the profile');await page.getByLabel('Expected result',{exact:true}).fill('Profile information is visible');
 await page.getByRole('button',{name:'Add step',exact:true}).click();await page.getByLabel('Action / instruction').nth(1).fill('Edit the display name');await page.getByLabel('Expected result',{exact:true}).nth(1).fill('Updated name is shown');
 await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});await page.getByRole('heading',{name:'Verify profile details',exact:true}).waitFor();
 let p=(await api('/api/state')).data.projects[0],created=p.tests.find(t=>t.name==='Verify profile details');assert.equal(created.qa.manualSteps.length,2);
 await page.getByRole('link',{name:'Test cases',exact:true}).click();await page.getByRole('searchbox',{name:'Search test cases',exact:true}).fill('profile');assert.equal(await page.locator('tbody tr').count(),1);
 await page.getByRole('checkbox',{name:'Select Verify profile details',exact:true}).check();await page.getByRole('button',{name:'Transfer to Test plan',exact:true}).click();await page.getByLabel('Test plan name',{exact:true}).fill('Profile verification');await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
 await page.goto(base+`/?projectId=${p.id}#case/${created.id}`);await page.getByRole('button',{name:'Run test case',exact:true}).click();await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});await page.getByRole('textbox',{name:'Actual result for step 1'}).fill('The profile was visible');await page.getByRole('button',{name:'Pass',exact:true}).first().click();
 await page.getByRole('textbox',{name:'Actual result for step 2'}).fill('The saved name did not update');await page.getByRole('button',{name:'Fail',exact:true}).nth(1).click();await page.getByRole('button',{name:'Complete run',exact:true}).click();await page.getByRole('link',{name:'HTML report',exact:true}).waitFor();
 let latest=(await api('/api/state')).data.runs[0];assert.equal(latest.status,'failed');assert.equal(latest.tests[0].steps[1].actualResult,'The saved name did not update');
 await page.screenshot({path:path.join(storage,'qa-manual-results.png'),fullPage:true});
 // A case with natural-language steps opens for mapping; it never fabricates an automated pass.
 await page.goto(base+`/?projectId=${p.id}#case/${created.id}`);await page.getByRole('button',{name:'Run test case',exact:true}).click();await page.getByRole('radio',{name:/Automation Studio/}).check();await page.locator('#dialog-submit').click();await page.waitForURL('**/automation?**');await page.getByRole('heading',{name:'Test case requirements'}).waitFor();await page.locator('.qa-context > summary').click();assert.match(await page.locator('.qa-context').innerText(),/Profile information is visible/);assert.equal((await api('/api/state')).data.runs.length,1);
 if(!(await page.locator('#workspace-menu').isVisible()))await page.locator('#workspace-toggle').click();await page.locator('#qa-return').click();await page.getByRole('heading',{name:'Verify profile details',exact:true}).waitFor();
 // The included executable demo is transferred and actually run in Chrome.
 p=(await api('/api/state')).data.projects[0];p.tests.find(t=>t.id==='welcome').inTestPlan=true;await api('/api/projects/'+p.id,'PUT',p);
 await page.goto(base+`/?projectId=${p.id}#case/welcome`);await page.getByRole('button',{name:'Run test case',exact:true}).click();await page.locator('#dialog-submit').click();await page.waitForURL('**/automation?**');
 for(let i=0;i<200;i++){const s=(await api('/api/state')).data;if(s.runs.length===2&&!s.activeRun){latest=s.runs[0];break;}await new Promise(r=>setTimeout(r,100));}
 assert.equal(latest.mode,'automation');assert.equal(latest.status,'passed',JSON.stringify(latest));assert.equal(latest.tests[0].steps.length,4);assert.ok(latest.tests[0].steps.every(s=>s.screenshot));
 const pdf=await(await fetch(base+`/api/runs/${latest.id}/report.pdf`)).arrayBuffer();assert.equal(Buffer.from(pdf).subarray(0,4).toString(),'%PDF');
 await page.goto(base);await page.getByRole('heading',{name:'Project overview'}).waitFor();await page.screenshot({path:path.join(storage,'qa-overview.png'),fullPage:true});
 await page.getByRole('link',{name:'Test cases',exact:true}).click();await page.getByRole('searchbox',{name:'Search test cases'}).fill('welcome');const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV'}).click();assert.equal((await downloadPromise).suggestedFilename(),'qa-studio-test-cases.csv');
 assert.deepEqual(errors,[]);console.log(`QA browser artifacts: ${storage}`);
});
