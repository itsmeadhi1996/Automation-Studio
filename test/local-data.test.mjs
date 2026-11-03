import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { normalizeLocalData, collectLocalData, readDataTable, resolveLocalValue } from '../local-data.mjs';
import { normalizeProject, sampleProject, prepareRun, resolveValue } from '../model.mjs';
import { initializeLocalData, preflight, executeRun, startDebugSession, redact } from '../runner.mjs';
import { createStudio } from './support.mjs';
import { createVault } from '../storage.mjs';

const entry = (name,source='manual',config={},extra={}) => ({name,source,config,value:'Alex',keepGlobal:false,...extra});

test('local definitions validate, survive normalization and remain isolated between tests',()=>{
  const raw=sampleProject(3100);raw.tests[0].inTestPlan=true;raw.tests[0].localTestData=[entry('NAME')];raw.tests[0].steps[1].valueMode='local';raw.tests[0].steps[1].value='NAME';
  const p=normalizeProject(raw,null,{nextTestNumber:1});assert.equal(p.tests[0].localTestData[0].value,'Alex');assert.equal(preflight(p).ok,true);
  const run=prepareRun(p);p.tests[0].localTestData[0].value='Changed';assert.equal(run.tests[0].localTestData[0].value,'Alex');
  assert.equal(resolveValue({valueMode:'local',value:'NAME'},{local:{NAME:'Alex'},globals:{NAME:'Other'}}),'Alex');
  assert.throws(()=>resolveValue({valueMode:'local',value:'NAME'},{globals:{NAME:'Other'}}),/not found/);
  assert.throws(()=>normalizeLocalData([entry('A'),entry('A')]),/Duplicate/);
  assert.throws(()=>normalizeLocalData([entry('__proto__')]),/variable name/);
  assert.throws(()=>normalizeLocalData([entry('A','random',{kind:'number',min:10,max:1})]),/bounds/);
  assert.throws(()=>normalizeLocalData([entry('A','database',{profileId:'db',query:'DELETE FROM users'})]),/SELECT/);
  p.tests[0].steps[1].value='MISSING';assert.equal(preflight(p).ok,false);
});

test('fresh random values are stable within a run; globals publish only after all sources succeed',async()=>{
  const raw=sampleProject(3100);raw.tests[0].inTestPlan=true;raw.tests[0].localTestData=[entry('TOKEN','random',{kind:'uuid'},{keepGlobal:true})];
  const p=normalizeProject(raw,null,{nextTestNumber:1}),a=prepareRun(p),b=prepareRun(p);let published;
  await initializeLocalData(a,a.tests[0],{onGlobals:values=>{published=values;}});await initializeLocalData(b,b.tests[0]);
  assert.notEqual(a.tests[0].localValues.TOKEN,b.tests[0].localValues.TOKEN);assert.equal(a.context.globals.TOKEN,published.TOKEN);
  assert.equal(redact(published.TOKEN,{local:a.tests[0].localValues}),'[redacted]');
  p.tests[0].localTestData.push(entry('BAD','environment',{variable:'MISSING'}));let calls=0;
  const failed=prepareRun(p);await assert.rejects(initializeLocalData(failed,failed.tests[0],{onGlobals:()=>calls++}),/Source variable not found/);assert.equal(calls,0);
});

test('suite readiness recognizes globals produced by earlier tests without collecting them',()=>{
  const raw=sampleProject(3100);raw.tests[0].inTestPlan=true;raw.tests[0].localTestData=[entry('NAME','random',{kind:'uuid'},{keepGlobal:true})];
  raw.tests.push({...structuredClone(raw.tests[0]),id:'consumer',name:'Consume global',localTestData:[]});
  raw.tests[1].steps[1].valueMode='global';raw.tests[1].steps[1].value='NAME';
  const p=normalizeProject(raw,null,{nextTestNumber:1});assert.equal(preflight(p,{suiteId:'smoke'}).ok,true);assert.equal(preflight(p,{testId:'consumer'}).ok,false);
});

test('database collection queries each time, selects cells, and rejects missing or truncated results',async()=>{
  const definition=normalizeLocalData([entry('NAME','database',{profileId:'db',query:'SELECT name FROM users',column:'name',row:2,selection:'fixed'})])[0];
  let calls=0;const query=async(profile,sql)=>{calls++;assert.equal(profile.id,'db');assert.match(sql,/SELECT/);return {columns:['name'],rows:[['Alex'],[`Sam${calls}`]]};};
  const context={profiles:[{id:'db'}]};
  assert.equal((await collectLocalData([definition],context,{query})).local.NAME,'Sam1');
  assert.equal((await collectLocalData([definition],context,{query})).local.NAME,'Sam2');
  await assert.rejects(resolveLocalValue(definition,context,{query:async()=>({columns:['name'],rows:[]})}),/no rows/);
  await assert.rejects(resolveLocalValue(definition,context,{query:async()=>({columns:['name'],rows:[['x']],valueTruncated:true})}),/too large/);
});

test('Excel sheets, CSV, JSON and current file contents can supply a value',async()=>{
  const workbook=new ExcelJS.Workbook();const first=workbook.addWorksheet('Users');first.addRows([['NAME','EMAIL'],['Alex','alex@example.test']]);const other=workbook.addWorksheet('Other');other.addRows([['NAME'],['Sam']]);
  const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
  const table=await readDataTable('users.xlsx',bytes,'Other');assert.deepEqual(table.rows,[['Sam']]);assert.deepEqual(table.sheets,['Users','Other']);
  assert.deepEqual((await readDataTable('data.json',Buffer.from('[{"NAME":"Jo","N":2}]'))).rows,[['Jo','2']]);
  assert.deepEqual((await readDataTable('data.csv',Buffer.from('NAME,NOTE\nAlex,"hello, world"'))).rows,[['Alex','hello, world']]);
  await assert.rejects(readDataTable('legacy.xls',bytes),/legacy/);
  await assert.rejects(readDataTable('data.json',Buffer.from('[{"A":{"nested":true}}]')),/cells/);
  const dir=path.resolve('.test-output',`local-file-${Date.now()}`);await mkdir(dir,{recursive:true});const filePath=path.join(dir,'users.xlsx');await writeFile(filePath,bytes);
  const definition=normalizeLocalData([entry('NAME','file',{filePath,sheet:'Users',column:'NAME',row:1})])[0];
  assert.equal((await resolveLocalValue(definition,{})).value,'Alex');first.getCell('A2').value='Updated';await workbook.xlsx.writeFile(filePath);
  assert.equal((await resolveLocalValue(definition,{})).value,'Updated');
});

test('browser runs and debug consume local values and refresh each dataset execution', {timeout:60000},async t=>{
  const port=3254,storage=path.resolve('.test-output',`local-run-${Date.now()}`),studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();t.after(()=>studio.close());
  const raw=sampleProject(port);raw.tests[0].inTestPlan=true;raw.tests[0].localTestData=[entry('NAME','random',{kind:'uuid'},{keepGlobal:true})];
  raw.tests[0].steps[1].valueMode='local';raw.tests[0].steps[1].value='NAME';raw.tests[0].steps[3].valueMode='local';raw.tests[0].steps[3].value='NAME';raw.tests[0].dataRows=[{ROW:'1'},{ROW:'2'}];
  const p=normalizeProject(raw,null,{nextTestNumber:1});assert.equal(preflight(p).ok,true);const run=prepareRun(p);await executeRun(run,path.join(storage,'artifacts'));
  assert.equal(run.status,'passed',JSON.stringify(run.tests.map(t=>t.error)));assert.notEqual(run.tests[0].localValues.NAME,run.tests[1].localValues.NAME);
  p.tests[0].dataRows=[];const session=await startDebugSession(p,p.tests[0].id,path.join(storage,'artifacts'));try{for(let i=0;i<4;i++)await session.step();assert.equal(session.run.status,'passed');assert.notEqual(session.run.tests[0].localValues.NAME,run.tests[0].localValues.NAME);}finally{await session.close();}
});

test('Local Test Data UI saves, previews uploads, validates duplicates, exports safely and runs with globals', {timeout:90000},async t=>{
  const port=3255,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`local-ui-${Date.now()}`),studio=await createStudio({port,storage});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation');await page.getByRole('button',{name:'Local Test Data',exact:true}).click();await page.getByRole('button',{name:'Add variable',exact:true}).click();
  await page.getByLabel('Variable name',{exact:true}).fill('NAME');await page.getByLabel('Value',{exact:true}).fill('Alex');await page.getByLabel('Keep in global variable',{exact:true}).check();await page.getByRole('button',{name:'Save variable',exact:true}).click();await page.locator('#dialog').waitFor({state:'hidden'});
  assert.equal(studio.store.projects[0].tests[0].localTestData[0].value,'Alex');assert.equal(studio.store.projects[0].globalVariables.NAME,undefined);
  await page.getByRole('button',{name:'Add variable',exact:true}).click();await page.getByLabel('Variable name',{exact:true}).fill('FILE_NAME');await page.locator('#local-data-source').selectOption('file');
  const workbook=new ExcelJS.Workbook();workbook.addWorksheet('Users').addRows([['NAME'],['Excel user']]);const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
  await page.locator('#local-data-file').setInputFiles({name:'users.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
  await page.getByText('Uploaded copy: users.xlsx',{exact:true}).waitFor();await page.getByRole('button',{name:'Preview value',exact:true}).click();await page.locator('#local-data-preview .local-data-value').filter({hasText:'Excel user'}).waitFor();
  await page.getByRole('button',{name:'Save variable',exact:true}).click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.screenshot({path:path.join(storage,'local-test-data.png'),fullPage:true});
  await page.getByRole('button',{name:'Add variable',exact:true}).click();await page.getByLabel('Variable name',{exact:true}).fill('NAME');await page.getByRole('button',{name:'Save variable',exact:true}).click();await page.getByText('This variable name already exists in the test',{exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Back to test editor',exact:true}).click();await page.getByLabel('Step 2 valueMode',{exact:true}).selectOption('local');await page.getByLabel('Step 2 value',{exact:true}).selectOption('NAME');await page.locator('#save-button').click();await page.getByText('Workspace saved',{exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Local Test Data',exact:true}).click();assert.equal(await page.locator('.local-data-table tbody tr').count(),2);
  await page.getByRole('button',{name:'Back to test editor',exact:true}).click();await page.locator('#run-button').click();
  for(let i=0;i<150;i++){if(studio.store.runs[0]&&studio.store.runs[0].status!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(studio.store.runs[0].status,'passed');assert.equal(studio.store.projects[0].globalVariables.NAME,'Alex');assert.equal(studio.store.runs[0].tests[0].localValues.FILE_NAME,'Excel user');
  // A server-published global revision must not cause the next ordinary editor save to conflict.
  await page.waitForTimeout(1700);await page.locator('.tabs [data-view="editor"]').click();await page.getByLabel('Test name',{exact:true}).fill('Local data example');await page.locator('#save-button').click();await page.getByText('Workspace saved',{exact:true}).waitFor();assert.equal(studio.store.projects[0].name,'Getting started');assert.equal(studio.store.projects[0].tests[0].name,'Local data example');
  const disk=await readFile(path.join(storage,'data/studio.json'),'utf8');assert.ok(!disk.includes('Excel user'));const vault=await createVault(path.join(storage,'data'));assert.equal(vault.decode(JSON.parse(disk)).projects[0].tests[0].localTestData[1].value,'Excel user');
  if(!(await page.locator('#workspace-menu').isVisible()))await page.locator('#workspace-toggle').click();await page.locator('[data-action="view"][data-view="settings"]').click();const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export project',exact:true}).click();const download=await downloadPromise;const exported=JSON.parse(await readFile(await download.path(),'utf8'));assert.deepEqual(exported.tests[0].localTestData.map(e=>[e.source,e.value]),[['manual',''],['manual','']]);assert.ok(exported.tests[0].localTestData.every(e=>!Object.hasOwn(e.config,'fileId')));
  assert.deepEqual(errors,[]);
});
