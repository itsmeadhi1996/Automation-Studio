import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { automationProject } from '../automation-model.mjs';
import { normalizeProject, prepareRun } from '../model.mjs';
import { caseRun, matchesCase, isIndividualCaseRun } from '../public/run-history.js';

test('case history preserves identity, dataset rows and case status inside a failed suite',()=>{
  const p=normalizeProject({name:'History',suites:[{id:'suite',name:'Smoke'}],tests:[
    {inTestPlan:true,id:'alpha',automation:{id:'auto-alpha',tcNumber:5},name:'Alpha',suiteId:'suite',dataRows:[{n:'1'},{n:'2'}],steps:[{action:'wait',value:'0'}]},
    {inTestPlan:true,id:'beta',name:'Beta',suiteId:'suite',steps:[{action:'wait',value:'0'}]}
  ]},null,{nextTestNumber:1});
  const run=prepareRun(automationProject(p),{suiteId:'suite'});run.status='failed';
  run.tests.forEach((item,index)=>{item.status=index===2?'failed':'passed';item.duration=10;});
  const before=JSON.stringify(run),scoped=caseRun(run,'alpha');
  assert.equal(scoped.tests.length,2);assert.equal(scoped.status,'passed');assert.equal(scoped.duration,20);assert.equal(scoped.totalTestCount,3);assert.equal(scoped.sourceStatus,'failed');assert.equal(scoped.suiteName,'Smoke');
  assert.equal(scoped.context,undefined);assert.equal(JSON.stringify(run),before);assert.equal(caseRun(run,'missing'),null);
  assert.ok(matchesCase(run.tests[0],'auto-alpha'));assert.ok(matchesCase(run.tests[0],'alpha'));
  run.status='running';assert.equal(caseRun(run,'alpha').status,'passed');
  run.tests[1].status='pending';assert.equal(caseRun(run,'alpha').status,'pending');
  assert.equal(caseRun(caseRun(run,'alpha'),'alpha').status,'pending','projecting an active suite case twice keeps pending rows pending');
  assert.equal(isIndividualCaseRun(run,'alpha'),false);
  assert.equal(isIndividualCaseRun({...run,suiteId:null,suiteName:null},'alpha'),false);
  assert.equal(isIndividualCaseRun({...scoped,suiteId:null,suiteName:null},'alpha'),false);
  const individual=prepareRun(automationProject(p),{testId:'auto-alpha'});
  assert.equal(isIndividualCaseRun(individual,'alpha'),true);
  assert.equal(isIndividualCaseRun(individual,'auto-alpha'),true);
  assert.equal(isIndividualCaseRun(individual,'beta'),false);
  assert.equal(isIndividualCaseRun({...individual,suiteId:'suite'},'alpha'),false);
  assert.equal(isIndividualCaseRun({...individual,suiteName:'Legacy suite'},'alpha'),false);
  assert.equal(isIndividualCaseRun({...individual,tests:[]},'alpha'),false);
  p.suites[0].name='Renamed';assert.equal(run.suiteName,'Smoke');
});

test('case history includes containing suites and grouped runs across pagination, reports and polling',{timeout:60000},async t=>{
  const storage=path.resolve('.test-output','case-history-'+Date.now()),studio=await createStudio({port:3813,storage});await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});const base='http://127.0.0.1:3813';
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
  const p=await api('/api/projects','POST',{name:'Case history',suites:[{id:'smoke',name:'Smoke suite'}],tests:[
    {inTestPlan:true,id:'alpha',automation:{id:'auto-alpha',tcNumber:20},name:'Alpha case',suiteId:'smoke',steps:[{name:'Alpha step',action:'wait',value:'0'}]},
    {inTestPlan:true,id:'beta',name:'Beta case',suiteId:'smoke',steps:[{name:'Beta step',action:'wait',value:'0'}]},
    {inTestPlan:true,id:'gamma',name:'Gamma case',steps:[{action:'wait',value:'0'}]},
    {inTestPlan:true,id:'delta',name:'Delta case',steps:[{action:'wait',value:'0'}]}
  ]});
  const projected=automationProject(p);let index=0;
  const snapshot=selector=>{const run=prepareRun(projected,selector);run.mode='automation';run.startedAt=new Date(Date.now()-(index++)*1000).toISOString();run.status='passed';run.tests.forEach(test=>{test.status='passed';test.duration=10;test.steps.forEach(step=>step.status='passed');});run.duration=10*run.tests.length;return run;};
  const newer=Array.from({length:110},()=>snapshot({testId:'beta'}));
  const suite=snapshot({suiteId:'smoke'});suite.status='failed';suite.tests[1].status='failed';suite.tests[1].error='BETA ONLY FAILURE';
  const individual=Array.from({length:51},()=>snapshot({testId:'auto-alpha'}));
  projected.tests[0].dataRows=[{row:'one'},{row:'two'}];const dataset=snapshot({testId:'auto-alpha'});
  const legacy=snapshot({testId:'auto-alpha'});legacy.tests=[{...legacy.tests[0],id:'old-automation-id',sourceTestId:'old-automation-id',name:'Alpha previous automation'}];
  studio.store.runs=[...newer,suite,...individual,dataset,legacy];
  let result=await api('/api/runs?projectId='+p.id+'&testId=alpha&scope=case&limit=100');
  assert.equal(result.total,54);assert.equal(result.runs[0].status,'passed');assert.equal(result.runs[0].tests.length,1);assert.ok(result.runs.every(run=>run.tests.every(test=>test.qaCaseId==='alpha')));
  assert.equal((await api('/api/runs?projectId='+p.id+'&testId=auto-alpha&scope=case')).total,53);
  const singleCaseSuite=snapshot({suiteId:'smoke',testIds:['auto-alpha']});
  const grouped=snapshot({testIds:['auto-alpha','gamma']});
  singleCaseSuite.startedAt=new Date(Date.now()+1000).toISOString();grouped.startedAt=new Date(Date.now()+2000).toISOString();
  studio.store.runs.unshift(grouped,singleCaseSuite);
  result=await api('/api/runs?projectId='+p.id+'&testId=alpha&scope=individual-case&limit=50');
  assert.equal(result.total,53);assert.equal(result.runs.length,50);
  assert.ok(result.runs.every(run=>isIndividualCaseRun(run,'alpha')));
  const older=await api('/api/runs?projectId='+p.id+'&testId=alpha&scope=individual-case&offset=50&limit=50');
  assert.equal(older.total,53);assert.equal(older.runs.length,3);
  assert.equal(older.runs.find(run=>run.id===dataset.id).tests.length,2);
  assert.equal((await api('/api/runs?projectId='+p.id+'&testId=gamma&scope=individual-case')).total,0);
  assert.equal((await fetch(base+'/api/runs?scope=individual-case')).status,400);
  const html=await(await fetch(base+'/api/runs/'+suite.id+'/report?testId=alpha')).text();assert.match(html,/Alpha case/);assert.doesNotMatch(html,/Beta case|BETA ONLY FAILURE/);
  const fullHtml=await(await fetch(base+'/api/runs/'+suite.id+'/report')).text();assert.match(fullHtml,/Beta case/);
  assert.equal((await fetch(base+'/api/runs/'+suite.id+'/report?testId=gamma')).status,404);
  const pdf=Buffer.from(await(await fetch(base+'/api/runs/'+suite.id+'/report.pdf?testId=alpha')).arrayBuffer());assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  result=await api('/api/runs?projectId='+p.id+'&testId=alpha&scope=case&limit=50');
  assert.equal(result.total,56);assert.equal(result.runs.length,50);
  assert.ok(result.runs.some(run=>run.id===suite.id));assert.ok(result.runs.some(run=>run.id===singleCaseSuite.id));assert.ok(result.runs.some(run=>run.id===grouped.id));
  const olderCases=await api('/api/runs?projectId='+p.id+'&testId=alpha&scope=case&offset=50&limit=50');
  assert.equal(olderCases.total,56);assert.equal(olderCases.runs.length,6);
  assert.equal(olderCases.runs.find(run=>run.id===dataset.id).tests.length,2);
  // Historical membership is snapshotted: unmapping today does not hide past suite reports.
  p.tests[0].suiteId=null;p.suites[0].name='Renamed suite';await api('/api/projects/'+p.id,'PUT',p);
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation?projectId='+p.id+'&testId=auto-alpha&view=history');
  await page.locator('.run-card').first().waitFor();

  assert.equal(await page.locator('.run-card').count(),10);
  assert.equal(await page.locator('.run-card[open]').count(),0);
  await page.locator('[name="testName"]').fill('Alpha');
  await page.getByRole('button',{name:'Apply filters'}).click();
  await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.includes('56 runs'));
  await page.locator('#history-size').selectOption('100');
  await page.waitForFunction(()=>document.querySelectorAll('.run-card').length===56);
  const suiteCard=page.locator('[data-run="'+suite.id+'"]');
  await suiteCard.locator(':scope > summary').click();
  assert.match(await suiteCard.innerText(),/Smoke suite/);
  const popupPromise=page.waitForEvent('popup');await suiteCard.getByRole('link',{name:'HTML report',exact:true}).click();
  const popup=await popupPromise;await popup.waitForLoadState();assert.match(await popup.locator('body').innerText(),/Beta case/);await popup.close();
  const downloadPromise=page.waitForEvent('download');await suiteCard.getByRole('link',{name:'PDF report',exact:true}).click();
  const download=await downloadPromise;assert.equal((await readFile(await download.path())).subarray(0,4).toString(),'%PDF');
  for(const width of [1365,768,390]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'History fits viewport '+width);}
  await page.setViewportSize({width:1365,height:950});
  projected.tests[0].dataRows=[];const added=snapshot({testId:'auto-alpha'});added.startedAt=new Date(Date.now()+3000).toISOString();studio.store.runs.unshift(added);
  await page.locator('#history-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.includes('57 runs'));
  if(!(await page.locator('#workspace-menu').isVisible()))await page.locator('#workspace-toggle').click();await page.locator('#explorer [data-view="cases"]').click();await page.locator('[data-action="select-test"][data-id="auto-alpha"]').click();
  await page.locator('#selected-case-status').waitFor();
  await page.waitForFunction(()=>document.querySelector('#selected-case-status').textContent.includes('passed'));
  assert.equal(studio.store.runs.find(run=>run.id===suite.id).tests.length,2);assert.equal(studio.store.runs.find(run=>run.id===suite.id).status,'failed');assert.deepEqual(errors,[]);
});
