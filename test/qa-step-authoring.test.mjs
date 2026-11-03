import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium} from 'playwright';
import {createStudio} from './support.mjs';
test('QA step authoring preserves values and identities across drag, copy, bulk copy and saves',{timeout:60000},async t=>{
 const studio=await createStudio({port:3368,storage:path.resolve('.test-output','qa-step-authoring-'+Date.now())});let browser;t.after(async()=>{await browser?.close();await studio.close();});await studio.listen();browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3368/');await page.getByRole('button',{name:'Create test case',exact:true}).click();await page.getByLabel('Test case title').fill('Step operations');
 const rows=page.locator('#step-editors .editor-step');
 for(const [i,text] of ['First','Second','Third'].entries()){if(i)await page.getByRole('button',{name:'Add step',exact:true}).click();await rows.nth(i).locator('[data-instruction]').fill(text);await rows.nth(i).locator('[data-expected]').fill('Expected '+text);}
 const original=await rows.evaluateAll(rows=>rows.map(row=>row.dataset.stepId));
 // Start the native drag before scrolling to a row outside the dialog viewport.
 // dragTo scrolls its target before the first mousemove, which can move the
 // pressed source away before Chromium has started a drag.
 const handle=rows.nth(2).locator('.step-drag-handle');await handle.hover();
 const start=await handle.boundingBox();await page.mouse.down();await page.mouse.move(start.x+start.width/2+12,start.y+start.height/2,{steps:3});
 await rows.nth(0).scrollIntoViewIfNeeded();const destination=await rows.nth(0).boundingBox();
 await page.mouse.move(destination.x+90,destination.y+5,{steps:5});await page.mouse.up();
 assert.deepEqual(await rows.locator('[data-instruction]').evaluateAll(inputs=>inputs.map(x=>x.value)),['Third','First','Second']);
 await page.getByRole('button',{name:'Copy step 1',exact:true}).click();assert.equal(await rows.count(),4);assert.equal(await rows.nth(1).locator('[data-expected]').inputValue(),'Expected Third');
 await rows.nth(1).locator('[data-instruction]').fill('Third copy edited');
 await page.getByLabel('Select step 2',{exact:true}).check();await page.getByLabel('Select step 4',{exact:true}).check();await page.locator('#copy-selected-steps').click();
 assert.deepEqual(await rows.locator('[data-instruction]').evaluateAll(inputs=>inputs.map(x=>x.value)),['Third','Third copy edited','First','Second','Third copy edited','Second']);
 const ids=await rows.evaluateAll(rows=>rows.map(row=>row.dataset.stepId));assert.equal(new Set(ids).size,6);assert.equal(ids[0],original[2]);assert.equal(ids[2],original[0]);
 await page.locator('#dialog-submit').click();await page.getByRole('heading',{name:'Step operations',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit case',exact:true}).click();assert.deepEqual(await rows.evaluateAll(rows=>rows.map(row=>row.dataset.stepId)),ids);
 await page.getByRole('button',{name:'Move step 1 down',exact:true}).click();await page.getByRole('button',{name:'Remove step 6',exact:true}).click();await page.getByLabel('Select all steps',{exact:true}).check();assert.equal(await rows.locator('[data-step-select]:checked').count(),5);await page.getByLabel('Select all steps',{exact:true}).uncheck();assert.equal(await page.locator('#copy-selected-steps').isDisabled(),true);
 await page.getByLabel('Select step 1',{exact:true}).check();await page.locator('#copy-selected-steps').click();assert.equal(await rows.count(),6);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.locator('#dialog-submit').click();await page.locator('#dialog').waitFor({state:'hidden'});
 await page.reload();await page.getByRole('heading',{name:'Step operations',exact:true}).waitFor();await page.getByRole('button',{name:'Edit case',exact:true}).click();assert.equal(await rows.count(),6);assert.equal(await rows.nth(0).locator('[data-instruction]').inputValue(),'Third copy edited');assert.equal(await rows.nth(1).locator('[data-instruction]').inputValue(),'Third copy edited');assert.deepEqual(errors,[]);
});
