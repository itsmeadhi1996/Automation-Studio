import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStudio } from './support.mjs';

test('switching QA folders and projects starts the case list at its first page',{timeout:30000},async t=>{
 const studio=await createStudio({port:3661,storage:path.resolve('.test-output',`pagination-design-${Date.now()}`)});
 t.after(()=>studio.close());await studio.listen();
 const base='http://127.0.0.1:'+studio.server.address().port;
 const projects=[];
 for(const name of ['Payments','Accounts']){
  const response=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,folders:[{id:'regression',name:'Regression'}],tests:Array.from({length:60},(_,i)=>({id:name+i,name:`${name} scenario ${i+1}`,folderId:'regression',steps:[]}))})});
  assert.equal(response.status,201);projects.push(await response.json());
 }
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(base+'/?projectId='+projects[0].id+'#cases');
 await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 2 of 2',{exact:true}).waitFor();
 await page.locator('[data-action="select-folder"][data-id="regression"]').click();await page.getByText('Page 1 of 2',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.locator('#project-select').selectOption(projects[1].id);await page.getByRole('heading',{name:'Project overview'}).waitFor();
 await page.locator('.sidebar').getByRole('link',{name:'Test cases',exact:false}).first().click();
 await page.getByText('Page 1 of 2',{exact:true}).waitFor();assert.match(await page.locator('.case-title').first().innerText(),/Accounts scenario 1$/);
});

test('QA workspace keeps results, filters, navigation and feedback accessible at every width',{timeout:60000},async t=>{
 const storage=path.resolve('.test-output',`workspace-design-${Date.now()}`);
 const studio=await createStudio({port:3657,storage});t.after(()=>studio.close());await studio.listen();
 const browser=await chromium.launch();t.after(()=>browser.close());
 const base='http://127.0.0.1:'+studio.server.address().port;
 const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
 const names=['Account access with valid credentials','Payment declined by issuer','Address validation with international characters','Order confirmation email'];
 const project=await api('/api/projects','POST',{name:'Release verification',tests:names.map((name,i)=>({id:'design-'+i,name,inTestPlan:true,steps:[],qa:{owner:i===1?'Ananya Rao':'José Martínez',priority:i===1?'critical':'medium',executionMode:'manual',manualSteps:[{id:'step-'+i,instruction:'Verify '+name,expectedResult:'The documented result is displayed.'}]}}))});
 let run=await api('/api/manual-runs','POST',{projectId:project.id,testIds:project.tests.slice(0,3).map(test=>test.id),name:'Release smoke checks'});
 for(const [i,status] of ['passed','failed','blocked'].entries())run=await api(`/api/manual-runs/${run.id}/steps`,'PUT',{revision:run.revision,testId:project.tests[i].id,stepIndex:0,status});
 await api(`/api/manual-runs/${run.id}/complete`,'POST',{revision:run.revision});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('net::ERR_FAILED'))errors.push(message.text());});
 await page.goto(base+'/?projectId='+project.id);await page.getByRole('heading',{name:'Project overview'}).waitFor();
 assert.match(await page.locator('.page-heading p').innerText(),/2 test cases need attention/);
 assert.equal(await page.locator('.case-title').first().innerText(),names[1]);
 assert.deepEqual(await page.locator('.result-track').evaluateAll(nodes=>nodes.map(node=>[node.value,node.max])),[[1,4],[1,4],[1,4],[1,4]]);
 const add=page.getByRole('button',{name:'New project',exact:true});await add.focus();await page.getByRole('tooltip',{name:'New project',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('tooltip').isVisible(),false);
 await page.getByRole('button',{name:'Show 1 failed test cases',exact:true}).click();await page.locator('.cases-panel').waitFor();assert.equal(await page.locator('.case-table tbody tr').count(),1);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await page.locator('.case-table tbody tr').count(),4);
 await page.getByRole('searchbox',{name:'Search test cases',exact:true}).fill('no such scenario');await page.getByText('No matching test cases',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Clear filters',exact:true}).last().click();assert.equal(await page.locator('.case-table tbody tr').count(),4);
 const firstChoice=page.getByRole('checkbox',{name:'Select '+names[0],exact:true});await firstChoice.focus();await page.keyboard.press('Space');
 assert.equal(await firstChoice.evaluate(node=>node===document.activeElement),true);assert.equal(await page.locator('#select-all').evaluate(node=>node.indeterminate),true);
 await page.getByRole('button',{name:'Clear',exact:true}).click();
 for(const width of [1440,1024,768,390,320]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Cases overflow at ${width}`);
  if(width<=640){const row=page.locator('.case-table tbody tr').first();for(const label of ['Priority','Execution','Last result','Assignee'])assert.equal(await row.locator(`[data-label="${label}"]`).isVisible(),true);}
 }
 await page.reload();await page.getByRole('heading',{name:'Test cases',exact:true}).waitFor();
 assert.equal(await page.locator('#sidebar').isVisible(),false);
 await page.getByRole('button',{name:'Menu',exact:true}).click();assert.equal(await page.locator('#sidebar').isVisible(),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#sidebar').isVisible(),false);assert.equal(await page.locator('#navigation-toggle').evaluate(node=>node===document.activeElement),true);
 await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('link',{name:'Overview',exact:true}).click();await page.getByRole('heading',{name:'Project overview'}).waitFor();assert.equal(await page.locator('#sidebar').isVisible(),false);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(storage,'mobile.png'),fullPage:true});
 await page.evaluate(()=>StudioUI.notify('Test case saved.'));assert.equal(await page.locator('#toast').getAttribute('role'),'status');await page.getByRole('button',{name:'Dismiss notification'}).click();assert.equal(await page.locator('#toast').isVisible(),false);
 await page.evaluate(()=>StudioUI.notify('The test case could not be saved. Try again.',true));assert.equal(await page.locator('#toast').getAttribute('role'),'alert');await page.getByRole('button',{name:'Dismiss notification'}).click();
 await page.route('**/api/state',route=>route.abort());await page.locator('#connection-banner').waitFor();assert.match(await page.locator('#connection-banner').innerText(),/last loaded results/);assert.equal(await page.locator('.case-table').isVisible(),true);
 await page.unroute('**/api/state');await page.getByRole('button',{name:'Retry now'}).click();await page.locator('#connection-banner').waitFor({state:'hidden'});
 await page.setViewportSize({width:1440,height:900});await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Dark mode',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.screenshot({path:path.join(storage,'desktop-dark.png'),fullPage:true});
 assert.deepEqual(errors,[]);
});

test('initial loading and error states preserve a usable retry action',{timeout:30000},async t=>{
 const studio=await createStudio({port:3658,storage:path.resolve('.test-output',`workspace-states-${Date.now()}`)});t.after(()=>studio.close());await studio.listen();
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage(),base='http://127.0.0.1:'+studio.server.address().port;
 let release;const pending=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/state',async route=>{await pending;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Workspace temporarily unavailable. Please try again.'})});});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Loading your workspace'}).waitFor();
 release();await page.getByRole('heading',{name:'Could not open QA Studio'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Try again',exact:true}).isVisible(),true);
 await page.unroute('**/api/state');await page.getByRole('link',{name:'Try again',exact:true}).click();await page.getByRole('heading',{name:'Project overview'}).waitFor();
});
