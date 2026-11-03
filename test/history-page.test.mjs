
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';
import { queryRunHistory } from '../history-query.mjs';
import { automationProject } from '../automation-model.mjs';
import { prepareRun } from '../model.mjs';
import { authorize } from '../auth.mjs';

test('dedicated history page requires Automation Studio permission',()=>{
 const user={role:'user',active:true,permissions:{qa:true,automation:false}};
 for(const route of ['/run-history','/history-page.js']){
  assert.throws(()=>authorize(user,route,'GET',new URL('http://localhost'+route)),error=>error.status===403);
  assert.doesNotThrow(()=>authorize({...user,permissions:{automation:true}},route,'GET',new URL('http://localhost'+route)));
 }
});

test('history filters combine before pagination and validate date/number boundaries',()=>{
 const rows=Array.from({length:125},(_,i)=>({id:String(i),startedAt:new Date(Date.UTC(2026,0,1+i)).toISOString(),status:i%2?'failed':'passed',suiteName:i%2?'Smoke':'Regression',tests:[{name:i%2?'Login':'Checkout'}]}));
 const q=new URLSearchParams({testName:'log',suiteName:'smo',status:'failed',from:'2026-01-01T00:00:00Z',to:'2026-05-31T23:59:59Z',limit:'10',offset:'10'});
 const r=queryRunHistory(rows,q);assert.equal(r.total,62);assert.equal(r.runs.length,10);assert.equal(r.offset,10);assert.ok(r.runs.every(r=>r.status==='failed'));assert.deepEqual(r.filters.testNames,['Checkout','Login']);
 q.set('offset','999');assert.equal(queryRunHistory(rows,q).offset,60);
 for(const patch of [{offset:'1.5'},{limit:'Infinity'},{from:'invalid'},{from:'2027-01-01',to:'2026-01-01'}])assert.throws(()=>queryRunHistory(rows,new URLSearchParams(patch)));
 assert.equal(queryRunHistory(rows,new URLSearchParams({from:rows[0].startedAt,to:rows[0].startedAt})).total,1);
});

test('history page filters all runs, collapses details, persists paging; editor retains off-page edits',{timeout:60000},async t=>{
 const storage=path.resolve('.test-output','history-page-'+Date.now());
 const studio=await createStudio({port:3352,storage});await studio.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});
 const base='http://127.0.0.1:3352';
 const api=async(url,method='GET',body)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
 const project=await api('/api/projects','POST',{name:'History pagination',suites:[{id:'smoke',name:'Smoke suite'}],tests:Array.from({length:30},(_,i)=>({inTestPlan:true,id:'test-'+i,name:'Case '+i,suiteId:i===0?'smoke':null,steps:Array.from({length:i===0?24:1},(_,j)=>({name:'Action '+j,action:'wait',value:'0'}))}))});
 const model=automationProject(project);
 studio.store.runs=Array.from({length:125},(_,i)=>{const run=prepareRun(model,i%2?{suiteId:'smoke'}:{testId:model.tests[1].id});run.status=i%2?'failed':'passed';run.startedAt=new Date(Date.UTC(2026,0,1+i,12)).toISOString();run.tests.forEach(test=>{test.status=run.status;test.steps.forEach(step=>step.status=run.status);});return run;});
 const result=await api('/api/runs?'+new URLSearchParams({projectId:project.id,testName:'Case 0',status:'failed',suiteName:'Smoke',limit:'10',offset:'50'}));
 assert.equal(result.total,62);assert.equal(result.runs.length,10);
 assert.equal((await fetch(base+'/api/runs?offset=Infinity')).status,400);
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/automation?projectId='+project.id+'&testId='+model.tests[0].id);
 await page.locator('.steps-table tbody tr').first().waitFor();
 assert.equal(await page.locator('.steps-table tbody tr').count(),10);
 await page.locator('[data-step="0"][data-key="value"]').fill('12');
 await page.getByRole('navigation',{name:'Test step pages'}).getByRole('button',{name:'Next',exact:true}).click();
 assert.equal(await page.locator('.steps-table tbody tr').first().getAttribute('data-row'),'10');
 await page.locator('[data-step="10"][data-key="value"]').fill('23');
 await page.getByRole('navigation',{name:'Test step pages'}).getByRole('button',{name:'Previous',exact:true}).click();
 assert.equal(await page.locator('[data-step="0"][data-key="value"]').inputValue(),'12');
 assert.equal(await page.locator('#explorer .test-directory-row,#explorer .tree-folder').count(),0);
 assert.equal(await page.getByRole('navigation',{name:'Test list pages'}).count(),0);
 assert.equal(await page.locator('#explorer [aria-label="Total test cases"]').textContent(),'30');
 await page.evaluate(()=>window.historyNavigationMarker='same document');
 await page.locator('#explorer [data-view="history"]').click();await page.waitForURL('**/automation?view=history*');
 assert.equal(await page.evaluate(()=>window.historyNavigationMarker),'same document');
 assert.equal(await page.locator('#main #history-filters').count(),1);
 assert.equal(await page.locator('#explorer [data-view="history"].selected').count(),1);
 assert.equal(await page.locator('.tabs [data-view="history"]').count(),0);
 await page.locator('.run-card').first().waitFor();
 assert.equal(await page.locator('.run-card').count(),10);assert.equal(await page.locator('.run-card[open],.run-test[open]').count(),0);
 const saved=(await api('/api/state')).projects.find(p=>p.id===project.id);assert.equal(saved.tests[0].steps[0].value,'12');assert.equal(saved.tests[0].steps[10].value,'23');
 await page.locator('#history-next').click();await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.startsWith('Page 2'));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.startsWith('Page 2'));
 await page.locator('[name="testName"]').fill('Case 0');await page.locator('[name="status"]').fill('failed');await page.locator('[name="suiteName"]').fill('Smoke');
 await page.getByRole('button',{name:'Apply filters'}).click();await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.includes('62 runs'));
 assert.equal(await page.locator('.run-card[open]').count(),0);
 await page.locator('.run-card>summary').first().click();assert.equal(await page.locator('.run-card[open]').count(),1);
 await page.locator('#history-refresh').click();await page.waitForFunction(()=>!document.querySelector('#history-refresh').disabled);assert.equal(await page.locator('.run-card[open]').count(),1);
 await page.locator('[name="from"]').fill('2026-02-01');await page.locator('[name="to"]').fill('2026-02-28');await page.getByRole('button',{name:'Apply filters'}).click();
 await page.waitForFunction(()=>document.querySelector('#history-page-label').textContent.includes('14 runs'));
 for(const width of [1365,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page fits '+width);}
 await page.screenshot({path:path.join(storage,'history-mobile.png')});
 await page.locator('[name="testName"]').fill('No matching case');await page.getByRole('button',{name:'Apply filters'}).click();await page.getByRole('heading',{name:'No matching runs'}).waitFor();
 assert.equal(await page.locator('#history-next').isDisabled(),true);assert.equal(await page.locator('#history-prev').isDisabled(),true);
 await page.setViewportSize({width:1365,height:900});
 await page.locator('#explorer [data-view="objects"]').click();
 await page.locator('#explorer [data-view="history"]').click();
 await page.getByRole('heading',{name:'No matching runs'}).waitFor();
 assert.equal(await page.locator('#main #history-filters').count(),1);
 assert.deepEqual(errors,[]);
});
