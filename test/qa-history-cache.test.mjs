import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';

test('QA dashboard refreshes indexed outcomes after manual saves and project switches', {timeout:30000}, async t => {
  const studio=await createStudio({port:3397,storage:path.resolve('.test-output','qa-history-'+Date.now())});
  let browser;
  t.after(async()=>{await browser?.close();await studio.close();});
  await studio.listen();
  const base='http://127.0.0.1:3397';
  const post=async(route,body)=>{
    const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.ok(response.ok,await response.clone().text());return response.json();
  };
  const tests=[{id:'shared',name:'Shared case',inTestPlan:true,qa:{manualSteps:[{id:'one',instruction:'Check result'}]}}];
  const project=await post('/api/projects',{name:'History cache A',tests});
  const other=await post('/api/projects',{name:'History cache B',tests});
  await post('/api/manual-runs',{projectId:project.id,testIds:['shared'],name:'Indexed manual run'});
  browser=await chromium.launch();const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?projectId='+project.id);
  const chart=()=>page.locator('.donut svg');
  await chart().waitFor();assert.equal(await chart().getAttribute('aria-label'),'0 passed, 0 failed, 0 blocked, 1 remaining');
  // Hold polling at 304 to prove the save response itself invalidates the index.
  await page.route('**/api/state',route=>route.fulfill({status:304}));
  await page.getByRole('link',{name:'Test runs',exact:true}).click();
  await page.getByRole('link',{name:/^Indexed manual run/}).click();
  await page.getByRole('button',{name:'Fail',exact:true}).click();
  await page.getByRole('button',{name:'Complete run',exact:true}).click();
  await page.getByRole('link',{name:'HTML report',exact:true}).waitFor();
  await page.getByRole('link',{name:'Overview',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.donut svg')?.getAttribute('aria-label')==='0 passed, 1 failed, 0 blocked, 0 remaining');
  await page.getByLabel('Project',{exact:true}).selectOption(other.id);
  assert.equal(await chart().getAttribute('aria-label'),'0 passed, 0 failed, 0 blocked, 1 remaining');
  await page.getByLabel('Project',{exact:true}).selectOption(project.id);
  assert.equal(await chart().getAttribute('aria-label'),'0 passed, 1 failed, 0 blocked, 0 remaining');
  assert.deepEqual(errors,[]);
});
