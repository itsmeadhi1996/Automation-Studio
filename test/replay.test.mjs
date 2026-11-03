import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { executeRun, executeStep } from '../runner.mjs';
import { normalizeProject, prepareRun } from '../model.mjs';
import { createStudio } from './support.mjs';

async function fixture(t) {
  const events=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/events'){
      let body='';for await(const part of req)body+=part;
      events.push(JSON.parse(body));res.end('ok');return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<label>Name<input id="name"></label><button id="submit">Continue</button><output id="result"></output><script>
      let highlightedAt=0;
      new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n.nodeName==='QA-STUDIO-LOCATOR-FOCUS')))highlightedAt=performance.now();}).observe(document.documentElement,{childList:true,subtree:true});
      const record=kind=>{
        const ring=document.querySelector('qa-studio-locator-focus')?.shadowRoot.querySelector('[data-locator-focus]');
        void fetch('/events',{method:'POST',body:JSON.stringify({kind,color:ring?getComputedStyle(ring).borderTopColor:null,heldFor:performance.now()-highlightedAt,at:Date.now()})});
      };
      document.querySelector('#name').oninput=()=>record('fill');
      document.querySelector('#submit').onclick=()=>{record('click');document.querySelector('#result').textContent='Done';};
    </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {url:'http://127.0.0.1:'+server.address().port,events};
}
const project=url=>normalizeProject({name:'Replay fixture',tests:[{inTestPlan:true,id:'case',name:'Visible replay',steps:[
  {name:'Open fixture',action:'navigate',value:url},
  {name:'Enter name',action:'fill',locatorType:'id',target:'name',value:'Replay tester'},
  {name:'Continue',action:'click',locatorType:'id',target:'submit'},
  {name:'Verify result',action:'text',locatorType:'id',target:'result',value:'Done'}
]}]},null,{nextTestNumber:1});

test('Replay launches a visible slow browser and holds red locators before real actions',{timeout:120000},async t=>{
  const {url,events}=await fixture(t),p=project(url),artifacts=path.resolve('.test-output','replay-'+Date.now());await mkdir(artifacts,{recursive:true});
  const launches=[];
  const browserLauncher=async(name,options)=>{launches.push({name,...options});return chromium.launch(options);};
  const replay=prepareRun(p,{testId:'case'});replay.replay=true;
  await executeRun(replay,artifacts,{browserLauncher});
  assert.equal(replay.status,'passed',JSON.stringify(replay));
  assert.equal(launches[0].headless,false);assert.ok(launches[0].slowMo>=250);
  assert.deepEqual(events.map(event=>event.kind),['fill','click']);
  for(const event of events){assert.equal(event.color,'rgb(229, 72, 77)');assert.ok(event.heldFor>=950,JSON.stringify(event));}
  assert.ok(events[1].at-events[0].at>=1750,'Actions remain separated by visible pauses');
  assert.ok(replay.tests[0].steps.slice(1).every(step=>step.targetScreenshots.length&&step.screenshot));
  const normal=prepareRun(p,{testId:'case'});await executeRun(normal,artifacts,{browserLauncher});
  assert.equal(normal.status,'passed',JSON.stringify(normal));assert.equal(launches[1].headless,true);assert.equal(launches[1].slowMo,0);
});

test('Stop during the highlight pause prevents the action from executing',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<button id="target" onclick="window.clicks++">Submit</button><script>window.clicks=0</script>');
  const controller=new AbortController();let pausedAt;
  await assert.rejects(executeStep(page,{action:'click',locatorType:'id',target:'target',value:''},{objects:[],signal:controller.signal,replay:{highlightMs:3000},onLocator:async handle=>{await handle.dispose();pausedAt=Date.now();setTimeout(()=>controller.abort(),40);}}),/aborted|cancelled/i);
  assert.ok(Date.now()-pausedAt<1000,'Stopping does not wait for the replay pause');
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('Editor Replay requests visible playback and rejects a server without replay support',{timeout:30000},async t=>{
  const studio=await createStudio({port:3812,storage:path.resolve('.test-output','replay-ui-'+Date.now())});studio.store.projects[0].tests.forEach(test=>test.inTestPlan=true);await studio.listen();
  const browser=await chromium.launch();t.after(async()=>{await browser.close();await studio.close();});const page=await browser.newPage(),base='http://127.0.0.1:3812';
  await page.goto(base+'/automation');await page.getByRole('button',{name:'Replay',exact:true}).waitFor();
  let request;
  await page.route('**/api/runs',async route=>{request=route.request().postDataJSON();await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Replay request captured'})});});
  await page.getByRole('button',{name:'Replay',exact:true}).click();await page.getByText('Replay request captured',{exact:true}).waitFor();assert.equal(request.replay,true);assert.ok(request.testId);
  request=null;
  await page.route('**/api/state?*',async route=>{const headers={...route.request().headers()};delete headers['if-none-match'];const response=await route.fetch({headers}),body=await response.json();delete body.features.visibleReplay;const responseHeaders={...response.headers()};delete responseHeaders.etag;delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];await route.fulfill({response,headers:responseHeaders,json:body});});
  await page.reload();await page.getByRole('button',{name:'Replay',exact:true}).click();await page.getByText('Restart QA Studio using Start QA Studio.cmd to enable visible slow-motion Replay.',{exact:true}).waitFor();assert.equal(request,null);
});