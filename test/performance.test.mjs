import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {acceptsGzip, createStaticResponder, sendText} from '../http-response.mjs';
import {queryExecutionOverview} from '../execution-overview.mjs';
import {caseRun, groupCaseRuns} from '../public/run-history.js';
import {waitAfterAction} from '../page-readiness.mjs';
import {createStudio} from './support.mjs';

function rawGet(url, headers={}) {
  return new Promise((resolve,reject)=>{
    http.get(url,{headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    }).on('error',reject);
  });
}

test('text transport negotiates compression and revalidates edited assets',async t=>{
  for(const value of ['gzip','br, gzip;q=0.5','*;q=1'])assert.equal(acceptsGzip(value),true);
  for(const value of ['', 'gzip;q=0','gzip;q=0, *;q=1','gzip;q=bad','gzip;q=2'])assert.equal(acceptsGzip(value),false);
  const directory=path.resolve('.test-output','transport-'+Date.now());await mkdir(directory,{recursive:true});
  const content='const greeting = "Hello world";\n'.repeat(2000);
  await writeFile(path.join(directory,'asset.js'),content);
  const staticResponse=createStaticResponder(directory);
  const server=http.createServer((req,res)=>{
    const response=req.url==='/small'?sendText(req,res,'{}'):staticResponse(req,res,'asset.js','text/javascript');
    response.catch(error=>{res.statusCode=500;res.end(error.message);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const plain=await rawGet(base),compressed=await rawGet(base,{'Accept-Encoding':'gzip'});
  assert.equal(plain.body.toString(),content);assert.equal(compressed.headers['content-encoding'],'gzip');
  assert.equal(gunzipSync(compressed.body).toString(),content);assert.ok(compressed.body.length<plain.body.length/5);
  assert.equal(compressed.headers.vary,'Accept-Encoding');assert.equal(compressed.headers['cache-control'],'private, no-cache');
  const unchanged=await rawGet(base,{'If-None-Match':'"another", '+plain.headers.etag,'Accept-Encoding':'gzip'});
  assert.equal(unchanged.status,304);assert.equal(unchanged.body.length,0);
  assert.equal((await rawGet(base,{'Accept-Encoding':'gzip;q=0, *;q=1'})).headers['content-encoding'],undefined);
  assert.equal((await rawGet(base+'/small',{'Accept-Encoding':'gzip'})).headers['content-encoding'],undefined);
  await writeFile(path.join(directory,'asset.js'),content+'\n// Updated');
  const changed=await rawGet(base,{'If-None-Match':plain.headers.etag});
  assert.equal(changed.status,200);assert.notEqual(changed.headers.etag,plain.headers.etag);assert.match(changed.body.toString(),/Updated$/);
});

test('case grouping preserves aliases, status precedence and startup errors',()=>{
  for(const status of ['running','failed','passed','interrupted']){
    const run={id:'run',status,error:'Startup failure',tests:[
      {id:'row1',sourceTestId:'automation',qaCaseId:'qa',status:'passed',duration:120,steps:[]},
      {id:'row2',sourceTestId:'automation',qaCaseId:'qa',status:'pending',steps:[{duration:30}]},
      {id:'other',status:'blocked',duration:20,steps:[]},
    ]};
    for(const grouped of groupCaseRuns(run))assert.deepEqual(grouped,caseRun(run,grouped.caseId));
    run.tests.forEach(test=>test.status='skipped');
    for(const grouped of groupCaseRuns(run))assert.deepEqual(grouped,caseRun(run,grouped.caseId));
  }
});

test('execution overview materializes evidence only for the requested page',()=>{
  let detailReads=0;
  const tests=Array.from({length:2500},(_,index)=>({id:'case-'+index,name:'Case '+index,status:'passed',duration:10,
    get steps(){detailReads++;return [{name:'Step',status:'passed',duration:10}];}}));
  const data=queryExecutionOverview([{id:'run',status:'passed',startedAt:'2026-01-01',tests}],new URLSearchParams({limit:'25',offset:'100'}));
  assert.equal(data.total,2500);assert.equal(data.summary.counts.passed,2500);assert.equal(data.summary.averageDuration,10);
  assert.equal(data.rows.length,25);assert.equal(detailReads,25);
});

test('same-document navigation keeps pending action requests and never repeats the action',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('https://spa.test/',route=>route.fulfill({contentType:'text/html',body:'<output>Pending</output>'}));
  await page.route('https://spa.test/work',async route=>{
    await new Promise(resolve=>setTimeout(resolve,1100));await route.fulfill({body:'Completed'});
  });
  await page.goto('https://spa.test/');
  await waitAfterAction(page,()=>page.evaluate(()=>{
    window.submissions=(window.submissions||0)+1;
    void fetch('/work').then(response=>response.text()).then(text=>document.querySelector('output').textContent=text);
    history.pushState({},'', '/result');
  }),{timeout:4000});
  assert.equal(await page.locator('output').textContent(),'Completed');assert.equal(await page.evaluate(()=>window.submissions),1);
});

test('state validators preserve authorization and history refreshes preserve focused controls', {timeout:45000},async t=>{
  const studio=await createStudio({port:3385,storage:path.resolve('.test-output','polling-'+Date.now())});await studio.listen();
  let browser;t.after(async()=>{await browser?.close();await studio.close();});
  const base='http://127.0.0.1:3385';
  const first=await rawGet(base+'/api/state');assert.equal(first.status,200);assert.ok(first.headers.etag);
  assert.equal(first.headers['cache-control'],'no-store');
  const unchanged=await rawGet(base+'/api/state',{'If-None-Match':first.headers.etag});assert.equal(unchanged.status,304);assert.equal(unchanged.body.length,0);
  studio.store.nextTestNumber++;
  assert.equal((await rawGet(base+'/api/state',{'If-None-Match':first.headers.etag})).status,200);
  assert.equal((await rawGet(base+'/api/state',{'If-None-Match':'*',Authorization:'Bearer invalid'})).status,401);
  assert.equal((await rawGet(base+'/app.js',{'If-None-Match':'*',Authorization:'Bearer invalid'})).status,401);
  const icon=await rawGet(base+'/favicon.ico',{Authorization:'Bearer invalid'});
  assert.equal(icon.status,200);assert.match(icon.headers['content-type'],/^image\/svg\+xml/);
  assert.equal((await rawGet(base+'/favicon.svg',{'If-None-Match':icon.headers.etag,Authorization:'Bearer invalid'})).status,304);
  const project=studio.store.projects[0];
  studio.store.runs.unshift({id:'fixture-run',projectId:project.id,status:'passed',startedAt:'2026-01-01',tests:[{id:'fixture-case',name:'Case',status:'passed',duration:10,steps:[]}]});
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/automation?projectId='+project.id+'&view=history');await page.locator('.run-card').waitFor();
  assert.ok(await page.evaluate(()=>StudioUI.pollState('/api/state?probe=1')));
  assert.equal(await page.evaluate(()=>StudioUI.pollState('/api/state?probe=1')),null);
  studio.store.nextTestNumber++;
  assert.ok(await page.evaluate(()=>StudioUI.pollState('/api/state?probe=1')));
  await page.locator('.run-card > summary').click();
  await page.evaluate(()=>{window.savedCard=document.querySelector('.run-card');window.savedCard.querySelector('a').focus();});
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs');
  await page.evaluate(()=>StudioHistory.refresh());await response;
  await page.waitForFunction(()=>!document.querySelector('#history-refresh').disabled);
  assert.equal(await page.evaluate(()=>window.savedCard===document.querySelector('.run-card')),true);
  assert.equal(await page.evaluate(()=>window.savedCard.contains(document.activeElement)),true);
  assert.equal(await page.locator('.tabs [data-view="editor"]').isVisible(),true);
  let requests=0,release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/runs?**',async route=>{requests++;await gate;await route.continue();});
  await page.evaluate(()=>{StudioHistory.refresh();StudioHistory.refresh();StudioHistory.refresh();});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(requests,1);release();await page.unrouteAll({behavior:'wait'});
  await page.goto(base+'/?projectId='+project.id+'#cases');
  const search=page.getByRole('searchbox',{name:'Search test cases',exact:true});
  await search.fill('Welcome');
  const original=project.tests[0].name;project.tests[0].name=original+' updated';project.revision++;
  await page.waitForFunction(name=>state.projects.some(p=>p.tests.some(t=>t.name===name)),project.tests[0].name);
  assert.equal(await search.inputValue(),'Welcome');
  assert.equal(await page.locator('.case-title').first().textContent(),original);
  await page.getByRole('button',{name:'Create test case',exact:true}).focus();
  await page.waitForFunction(name=>document.querySelector('.case-title')?.textContent===name,project.tests[0].name);
  assert.deepEqual(errors,[]);
});
