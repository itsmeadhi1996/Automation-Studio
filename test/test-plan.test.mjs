import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import {createStudio} from './support.mjs';
import {normalizeProject, prepareRun} from '../model.mjs';
import {createManualRun} from '../qa-model.mjs';
import {automationProject, mergeAutomationProject} from '../automation-model.mjs';
import {qaProjectInput} from '../auth.mjs';

const fixture=()=>({name:'Plan workflow',suites:[{id:'suite',name:'Regression'}],tests:[
  {id:'ready',name:'Ready case',suiteId:'suite',steps:[{action:'wait',value:'0'}]},
  {id:'draft',name:'Draft case',additionalSuiteIds:['suite'],steps:[{action:'wait',value:'0'}]}
]});

test('manual plan membership remains durable while automation executes directly',()=>{
  const counter={nextTestNumber:1};let p=normalizeProject(fixture(),null,counter);
  assert.ok(p.tests.every(t=>t.inTestPlan===false));
  for(const run of [createManualRun]) {
    assert.throws(()=>run(p,{testId:'ready'}),/Test plan/);
    assert.throws(()=>run(p,{suiteId:'suite'}),/Test plan/);
  }
  assert.deepEqual(prepareRun(p,{suiteId:'suite'}).tests.map(t=>t.id),['ready','draft']);
  assert.equal(prepareRun(p,{testId:'ready'}).tests.length,1);
  assert.throws(()=>prepareRun(p,{testId:'missing'}),/existing/);
  assert.throws(()=>prepareRun(p,{testIds:[]}),/existing/);
  p.tests[0].inTestPlan=true;
  p.tests[0].automation={id:'mapped-ready',tcNumber:30};
  p=normalizeProject(qaProjectInput(p,p),p,counter);
  const input=structuredClone(p);delete input.tests[0].inTestPlan;
  p=normalizeProject(input,p,counter);assert.equal(p.tests[0].inTestPlan,true);
  const mapped=automationProject(p);
  assert.equal(prepareRun(mapped,{testId:'mapped-ready'}).tests[0].qaCaseId,'ready');
  assert.equal(normalizeProject(mergeAutomationProject(mapped,p),p,counter).tests[0].inTestPlan,true);
  for(const run of [createManualRun]) {
    assert.deepEqual(run(p,{suiteId:'suite'}).tests.map(t=>t.id),['ready']);
    assert.deepEqual(run(p,{}).tests.map(t=>t.id),['ready']);
    assert.throws(()=>run(p,{testIds:['ready','draft']}),/Test plan/);
    assert.throws(()=>run(p,{testId:'missing'}),/existing/);
    assert.throws(()=>run(p,{testIds:[]}),/existing/);
    const snapshot=run(p,{testId:'ready'});
    p.tests[0].inTestPlan=false;
    assert.equal(snapshot.tests.length,1);
    assert.throws(()=>run(p,{testId:'ready'}),/Test plan/);
    p.tests[0].inTestPlan=true;
  }
  p.tests[1].inTestPlan=true;
  assert.equal(prepareRun(p,{suiteId:'suite'}).tests.length,2);
  p.tests[0].dataRows=[{VALUE:'one'},{VALUE:'two'}];
  assert.equal(prepareRun(p,{testId:'ready'}).tests.length,2);
  const invalid=structuredClone(p);invalid.tests[0].inTestPlan='true';
  assert.throws(()=>normalizeProject(invalid,p,counter),/membership/);
});

async function setup(t,label){
  const storage=path.resolve('.test-output',`test-plan-${label}-${Date.now()}`);
  const studio=await createStudio({port:label==='api'?3391:3392,storage});
  t.after(()=>studio.close());await studio.listen();
  const base='http://127.0.0.1:'+studio.server.address().port;
  const api=async(route,method='GET',body)=>{
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const p=(await api('/api/projects','POST',fixture())).data;
  return {studio,base,api,p,storage};
}

test('automation runs, replay, debug and schedules work without manual plan membership',{timeout:60000},async t=>{
  const {api,p,studio}=await setup(t,'api');
  assert.equal((await api('/api/manual-runs','POST',{projectId:p.id,testId:'ready'})).status,400);
  const readiness=await api('/api/preflight','POST',{projectId:p.id,testId:'ready'});
  assert.equal(readiness.status,200);assert.equal(readiness.data.ok,true);
  for(const selector of [{testId:'ready'},{testIds:['ready','draft']},{suiteId:'suite'},{testId:'ready',replay:true}]){
    const result=await api('/api/runs','POST',{projectId:p.id,...selector});assert.equal(result.status,202,JSON.stringify(result));
    assert.deepEqual(result.data.tests.map(t=>t.id),selector.testId?['ready']:['ready','draft']);
    await expect.poll(async()=> (await api('/api/state')).data.activeRun,{timeout:30000}).toBeNull();
    assert.equal((await api('/api/runs/'+result.data.id)).data.status,'passed');
  }
  const debug=await api('/api/debug','POST',{projectId:p.id,testId:'ready'});assert.equal(debug.status,201,JSON.stringify(debug));
  assert.equal((await api('/api/debug/'+debug.data.id+'/close','POST',{})).status,200);
  const schedule=await api('/api/schedules','POST',{projectId:p.id,testId:'ready',intervalMinutes:60});assert.equal(schedule.status,201);
  studio.store.schedules.find(s=>s.id===schedule.data.id).nextRunAt=new Date(0).toISOString();await studio.tickSchedules();
  const scheduled=studio.store.schedules.find(s=>s.id===schedule.data.id);assert.equal(scheduled.lastError,null);assert.ok(scheduled.lastRunId);
  await expect.poll(async()=> (await api('/api/state')).data.activeRun,{timeout:30000}).toBeNull();
  assert.equal((await api('/api/runs/'+scheduled.lastRunId)).data.status,'passed');
  assert.ok((await api('/api/state')).data.projects.find(x=>x.id===p.id).tests.every(t=>!t.inTestPlan));
});

test('multiple selected cases save as one durable plan; progress and execution stay scoped to that plan',{timeout:60000},async t=>{
 const {api,p,base,storage}=await setup(t,'browser');
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/?projectId='+p.id+'#cases');
 await page.getByRole('checkbox',{name:'Select Ready case',exact:true}).check();
 await page.getByRole('checkbox',{name:'Select Draft case',exact:true}).check();
 await page.getByRole('button',{name:'Transfer to Test plan',exact:true}).click();
 await expect(page.getByLabel('Test plan name',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal((await api('/api/state')).data.projects.find(x=>x.id===p.id).testPlans.length,0);
 await page.getByRole('button',{name:'Transfer to Test plan',exact:true}).click();
 await page.getByLabel('Test plan name',{exact:true}).fill('Release acceptance');
 await page.getByLabel('Assign to',{exact:true}).fill('Alex');
 await page.getByLabel('Release',{exact:true}).fill('Release 3.0');
 await page.locator('#dialog-submit').click();
 await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'View 2 test cases in Release acceptance',exact:true})).toBeVisible();
 let saved=(await api('/api/state')).data.projects.find(x=>x.id===p.id),plan=saved.testPlans[0];
 assert.deepEqual(plan.testIds,['ready','draft']);assert.equal(plan.createdBy,'Test administrator');assert.equal(plan.assignedTo,'Alex');assert.ok(Date.parse(plan.createdAt));
 assert.equal((await api('/api/state')).data.runs.length,0);
 await page.reload();await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await page.getByRole('button',{name:'Run Release acceptance',exact:true}).click();
 await expect(page.locator('#dialog-body input[name="name"]')).toHaveValue('Release acceptance');
 await page.getByRole('radio',{name:/Manual testing/}).check();await page.locator('#dialog-submit').click();
 await expect(page.getByRole('button',{name:'Complete run',exact:true})).toBeVisible();
 const run=(await api('/api/state')).data.runs[0];assert.equal(run.planId,plan.id);assert.equal(run.tests.length,2);
 assert.equal((await api('/api/manual-runs/'+run.id+'/steps','PUT',{revision:run.revision,testId:'ready',stepIndex:0,status:'passed'})).status,200);
 await page.goto(base+'/?projectId='+p.id+'#plan');
 await expect(page.getByRole('img',{name:'1 passed, 1 pending',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Copy Release acceptance',exact:true}).click();
 await page.locator('#dialog-submit').click();await expect(page.locator('#plan-results tbody tr')).toHaveCount(2);
 await expect(page.getByRole('img',{name:'2 untested',exact:true})).toBeVisible();
 const copy=(await api('/api/state')).data.projects.find(x=>x.id===p.id).testPlans.find(x=>x.name==='Release acceptance (copy)');
 const automated=await api('/api/runs','POST',{projectId:p.id,planId:copy.id});assert.equal(automated.status,202);
 await expect.poll(async()=> (await api('/api/state')).data.activeRun,{timeout:30000}).toBeNull();
 await page.reload();
 await expect(page.getByRole('img',{name:'2 passed',exact:true})).toBeVisible();
 await expect(page.locator('.plan-segment.passed').last()).toHaveCSS('flex-grow','2');
 assert.ok(await page.locator('.plan-segment.passed').last().evaluate(el=>el.getBoundingClientRect().width>100));
 await page.screenshot({path:path.join(storage,'saved-test-plans.png'),fullPage:true});
 await page.getByRole('button',{name:'Edit Release acceptance (copy)',exact:true}).click();
 await page.locator('#dialog-body select[name="status"]').selectOption('closed');await page.locator('#dialog-submit').click();
 await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Run Release acceptance (copy)',exact:true})).toHaveCount(0);
 await page.getByLabel('Plan status',{exact:true}).selectOption('open');
 await page.getByRole('button',{name:'Delete Release acceptance',exact:true}).click();await page.locator('#dialog-submit').click();
 saved=(await api('/api/state')).data.projects.find(x=>x.id===p.id);
 assert.equal(saved.testPlans.length,1);assert.equal(saved.tests.length,2);assert.ok(saved.tests.every(t=>t.inTestPlan));assert.equal(saved.tests[0].suiteId,'suite');
 await page.goto(base+'/automation?projectId='+p.id+'&view=cases');
 await page.getByRole('checkbox',{name:'Select Ready case',exact:true}).check();
 await expect(page.locator('[data-action="cases-add-to-plan"]')).toHaveCount(0);
 await expect(page.locator('[data-view="plan"]')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Run selected',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Run selected',exact:true}).click();
 await expect.poll(async()=> (await api('/api/state')).data.activeRun,{timeout:30000}).toBeNull();
 assert.equal((await api('/api/state')).data.projects.find(x=>x.id===p.id).testPlans.length,1);
 assert.deepEqual(errors,[]);
});

test('screenshot filters and pagination operate on saved plans',{timeout:60000},async t=>{
 const {api,p,base}=await setup(t,'filters');
 p.testPlans=Array.from({length:13},(_,i)=>({id:'plan-'+i,name:'Execution '+i,testIds:['ready','draft'],assignedTo:i<2?'Alex':'Sam',release:i<2?'Release 1':'Release 2',status:i===12?'closed':'open'}));
 assert.equal((await api('/api/projects/'+p.id,'PUT',p)).status,200);
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.goto(base+'/?projectId='+p.id+'#plan');
 await expect(page.locator('#plan-results tbody tr')).toHaveCount(10);
 await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.locator('#plan-results tbody tr')).toHaveCount(2);
 await page.getByLabel('Assign to',{exact:true}).selectOption('Alex');await expect(page.locator('#plan-results tbody tr')).toHaveCount(2);
 await page.getByLabel('Release',{exact:true}).selectOption('Release 2');await expect(page.getByText('No matching test plans',{exact:true})).toBeVisible();
 await page.getByLabel('Assign to',{exact:true}).selectOption('');await page.getByLabel('Release',{exact:true}).selectOption('');
 await page.getByLabel('Entries per page',{exact:true}).selectOption('25');await expect(page.locator('#plan-results tbody tr')).toHaveCount(12);
 await page.getByLabel('Search By TestRun',{exact:true}).fill('Execution 11');await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await page.getByLabel('Search By TestRun',{exact:true}).fill('');
 await page.getByLabel('Plan status',{exact:true}).selectOption('closed');await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await page.getByLabel('Selection type',{exact:true}).selectOption('Specific');await expect(page.locator('#plan-results tbody tr')).toHaveCount(1);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();await expect(page.locator('#plan-results tbody tr')).toHaveCount(13);
 await expect(page.getByLabel('Plan status',{exact:true})).toHaveValue('');
});

test('saved plan metadata survives both workspaces and rejects invalid or out-of-plan execution',()=>{
 const counter={nextTestNumber:1};let p=normalizeProject({...fixture(),testPlans:[{id:'one',name:'First plan',testIds:['ready'],createdBy:'Author',assignedTo:'Alex',release:'R1'}]},null,counter);
 const createdAt=p.testPlans[0].createdAt;
 assert.equal(p.tests[0].inTestPlan,true);assert.equal(p.tests[1].inTestPlan,false);
 assert.throws(()=>createManualRun(p,{planId:'one',testIds:['draft']}),/outside/);
 assert.throws(()=>prepareRun(p,{planId:'missing'}),/Unknown test plan/);
 p.tests[0].automation={id:'mapped-ready',tcNumber:30};
 const run=prepareRun(automationProject(p),{planId:'one'});assert.equal(run.planId,'one');assert.equal(run.tests[0].qaCaseId,'ready');assert.equal(run.name,'First plan');
 p=normalizeProject(mergeAutomationProject(automationProject(p),p),p,counter);
 p=normalizeProject(qaProjectInput(p,p),p,counter);assert.equal(p.testPlans[0].createdAt,createdAt);
 p.testPlans[0].status='closed';assert.throws(()=>createManualRun(p,{planId:'one'}),/Reopen/);
 const invalid=structuredClone(p);invalid.testPlans[0].testIds=['missing'];assert.throws(()=>normalizeProject(invalid,p,counter),/existing test cases/);
 const deleted=structuredClone(p);deleted.tests=[];assert.deepEqual(normalizeProject(deleted,p,counter).testPlans[0].testIds,[]);
});

 test('state retains the latest saved-plan result beyond the recent-history window',{timeout:60000},async t=>{
  const {api,p,studio}=await setup(t,'history');
  p.testPlans=[{id:'saved-plan',name:'Long-lived plan',testIds:['ready']}];
  assert.equal((await api('/api/projects/'+p.id,'PUT',p)).status,200);
  const execution=(await api('/api/manual-runs','POST',{projectId:p.id,planId:'saved-plan'})).data;
  studio.store.runs.unshift(...Array.from({length:105},(_,i)=>({...execution,id:'unrelated-'+i,planId:undefined})));
  const loaded=(await api('/api/state')).data.runs;
  assert.equal(loaded.length,101);assert.ok(loaded.some(run=>run.id===execution.id));
 });

test('legacy plans remain in QA and old Automation plan links open Test cases',{timeout:60000},async t=>{
 const {api,p,base,studio}=await setup(t,'legacy');
 const legacy=studio.store.projects.find(x=>x.id===p.id);delete legacy.testPlans;
 for(const item of legacy.tests)item.inTestPlan=true;
 const run=createManualRun(legacy,{testId:'ready',name:'Test Data'});
 run.startedAt='2026-10-01T12:00:00.000Z';run.tests[0].status='passed';run.status='passed';
 studio.store.runs.unshift(run);
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/?projectId='+p.id+'#plan');
 await expect(page.getByRole('button',{name:'Test Data',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Transferred test cases',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'1 passed',exact:true})).toBeVisible();
 await page.reload();await expect(page.locator('#plan-results tbody tr')).toHaveCount(2);
 await page.goto(base+'/automation?projectId='+p.id+'&view=plan');
 await expect(page.locator('.auto-cases-table')).toBeVisible();
 assert.equal(new URL(page.url()).searchParams.get('view'),'cases');
 await expect(page.locator('[data-view="plan"],.test-plan-page')).toHaveCount(0);
 await page.reload();await expect(page.locator('.auto-cases-table')).toBeVisible();
 await page.goto(base+'/?projectId='+p.id+'#plan');
 await expect(page.locator('#plan-results tbody tr')).toHaveCount(2);
 await expect(page.getByRole('img',{name:'1 passed',exact:true})).toBeVisible();
 assert.deepEqual(errors,[]);
});

test('legacy recovery deduplicates repeat runs, handles mapped cases and respects explicitly deleted plans',async()=>{
 const {recoverTestPlans}=await import('../public/run-history.js');
 const p=normalizeProject(fixture(),null,{nextTestNumber:1});delete p.testPlans;p.tests[0].inTestPlan=true;p.tests[0].automation={id:'mapped',tcNumber:42};
 const runs=[{id:'new',projectId:p.id,name:'Test Data',startedAt:'2026-10-02T00:00:00Z',tests:[{id:'mapped-row-1',sourceTestId:'mapped'},{id:'mapped-row-2',sourceTestId:'mapped'}]},{id:'old',projectId:p.id,name:'Test Data',startedAt:'2026-10-01T00:00:00Z',tests:[{id:'ready'}]}];
 const recovered=recoverTestPlans(p,runs);
 assert.equal(recovered.testPlans.length,1);assert.equal(recovered.testPlans[0].id,'legacy-new');assert.equal(recovered.testPlans[0].createdAt,runs[1].startedAt);assert.deepEqual(recovered.testPlans[0].testIds,['ready']);assert.equal(p.testPlans,undefined);
 assert.deepEqual(recoverTestPlans({...p,testPlans:[]},runs).testPlans,[]);
 assert.deepEqual(recoverTestPlans(automationProject(p),runs).testPlans,recovered.testPlans);
});
