import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {executeRun,executeStep,DebugSession} from '../runner.mjs';
import {normalizeProject,prepareRun} from '../model.mjs';
import {reportHtml} from '../reports.mjs';

async function fixture(t){
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.url==='/frame')return res.end('<style>body{margin:0}#spacer{height:1100px}input{width:200px;height:45px}</style><div id="spacer"></div><input id="value" value="Frame value"><input type="password" value="Never show this">');
  if(req.url==='/next')return res.end('<h1>Next page</h1>');
  res.end('<style>body{margin:0}header{position:fixed;top:0;height:70px;background:#ccc;width:100%;z-index:20}#spacer{height:1800px}#message{width:240px;height:60px;margin:30px}iframe{display:block;height:320px;width:650px;margin:30px}a{display:block;width:200px;height:40px;margin:30px}</style><header>Fixed header</header><div id="spacer"></div><div id="message">Ready</div><iframe id="frame" src="/frame"></iframe><a id="next" href="/next">Next</a>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return 'http://127.0.0.1:'+server.address().port;
}
const makeProject=url=>normalizeProject({id:'focus',name:'Focus locator',browser:'chrome',tests:[{inTestPlan:true,id:'case',name:'Read and navigate',steps:[
 {name:'Open page',action:'navigate',value:url},
 {name:'Read text',action:'text',locatorType:'id',target:'message',value:'Ready'},
 {name:'Read field in frame',action:'value',locatorType:'id',target:'value',framePath:['#frame'],value:'Frame value'},
 {name:'Navigate from locator',action:'click',locatorType:'id',target:'next'},
 {name:'Check destination',action:'heading',value:'Next page'}
]}]},null,{nextTestNumber:1});

async function redPixelCount(browser,bytes){
 const page=await browser.newPage();
 try {return await page.evaluate(async src=>{
   const img=new Image();img.src=src;await img.decode();
   const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
   const data=ctx.getImageData(0,0,img.width,img.height).data;let red=0;
   for(let i=0;i<data.length;i+=4)if(data[i]===229&&data[i+1]===72&&data[i+2]===77)red++;
   return red;
 },'data:image/png;base64,'+bytes.toString('base64'));}finally{await page.close();}
}

test('text and field assertions center locator targets without changing keyboard focus',async t=>{
 const url=await fixture(t),browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(url);
 await page.evaluate(()=>window.focusEvents=0);
 await page.locator('#message').evaluate(el=>el.addEventListener('focus',()=>window.focusEvents++));
 await executeStep(page,{action:'text',locatorType:'id',target:'message',value:'Ready'},{objects:[],timeoutMs:2000});
 const box=await page.locator('#message').boundingBox();
 assert.ok(box.y>70&&box.y+box.height<900);
 assert.ok(Math.abs(box.y+box.height/2-450)<100);
 assert.equal(await page.evaluate(()=>window.focusEvents),0);
 assert.equal(await page.locator('[data-locator-focus]').evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(229, 72, 77)');
 await executeStep(page,{action:'value',locatorType:'id',target:'value',framePath:['#frame'],value:'Frame value'},{objects:[],timeoutMs:2000});
 const nested=page.frameLocator('#frame').locator('#value'),frameBox=await nested.boundingBox();
 assert.ok(frameBox.y>70&&frameBox.y+frameBox.height<900);
 await executeStep(page,{action:'hidden',locatorType:'id',target:'missing',value:''},{objects:[],timeoutMs:500});
 assert.equal(await page.locator('[data-locator-focus]').count(),0);
});

test('run and debug screenshots retain exact target evidence across navigation and failure',{timeout:60000},async t=>{
 const url=await fixture(t),p=makeProject(url),artifacts=path.resolve('.test-output','locator-focus-'+Date.now());
 await mkdir(artifacts,{recursive:true});
 const run=prepareRun(p,{testId:'case'});await executeRun(run,artifacts);
 assert.equal(run.status,'passed',JSON.stringify(run));
 const browser=await chromium.launch();t.after(()=>browser.close());
 for(const step of run.tests[0].steps.slice(1)){
   assert.equal(step.targetScreenshots.length,1,step.name);
   const bytes=await readFile(path.join(artifacts,step.targetScreenshots[0]));
   assert.ok(await redPixelCount(browser,bytes)>100,step.name+' must show a red target outline');
   assert.ok(step.screenshot);
 }
 const html=await reportHtml(run,artifacts);
 assert.match(html,/Locator screenshot/);
 const debugRun=prepareRun(p,{testId:'case'}),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 const debug=new DebugSession(debugRun,browser,context,page,artifacts);
 await debug.step();await debug.step();
 assert.equal(debug.summary().currentStep.targetScreenshots.length,1);
 debugRun.tests[0].steps[2].value='Wrong expected value';debugRun.tests[0].steps[2].timeoutMs=500;
 await debug.step();
 assert.equal(debug.summary().status,'failed');
 assert.equal(debug.summary().currentStep.targetScreenshots.length,1);
 assert.ok(debug.summary().currentStep.screenshot);
 assert.ok(await redPixelCount(browser,await readFile(path.join(artifacts,debug.summary().currentStep.screenshot)))>100);
 await debug.close();
 console.log('Locator screenshots: '+artifacts);
});


// Replace the target at the scroll boundary to reproduce reactive UI updates.
for (const browserName of ['chromium','firefox']) {
 test(`${browserName}: scrolling recovers from a detached target and clicks only once`,{timeout:15000},async t=>{
  const {firefox}=await import('playwright');
  const browser=await (browserName==='firefox'?firefox:chromium).launch(browserName==='firefox'?{env:{...process.env,MOZ_DISABLE_CONTENT_SANDBOX:'1'}}:{});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  await page.setContent('<div style="height:1600px"></div><button id="target" style="height:50px">Continue</button><div style="height:900px"></div>');
  await page.evaluate(()=>{window.clicks=0;document.addEventListener('click',event=>{if(event.target.id==='target')window.clicks++;});});
  const original=page.locator.bind(page);let replaced=false;
  page.locator=(...args)=>{
   const target=original(...args),scroll=target.scrollIntoViewIfNeeded.bind(target);
   target.scrollIntoViewIfNeeded=async options=>{
    if(!replaced){
     replaced=true;
     const stale=await target.elementHandle();
     try{
      await stale.evaluate(node=>node.replaceWith(node.cloneNode(true)));
      await stale.scrollIntoViewIfNeeded(options);
     }finally{await stale.dispose();}
    }
    return scroll(options);
   };
   return target;
  };
  await executeStep(page,{action:'click',locatorType:'id',target:'target',value:'',timeoutMs:2500},{objects:[]});
  assert.equal(await page.evaluate(()=>window.clicks),1);
  const box=await original('#target').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=700);
  assert.equal(await page.locator('[data-locator-focus]').count(),1);
 });
}

test('focus handles nested smooth scrolling and tracks layout movement',async t=>{
 const {focusLocator,clearLocatorFocus}=await import('../locator-focus.mjs');
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1000,height:700}});
 await page.setContent('<style>html{scroll-behavior:smooth}#container{height:250px;overflow:auto;scroll-behavior:smooth}#target{height:40px;width:120px}</style><div style="height:1200px"></div><div id="container"><div style="height:900px"></div><div id="target">Visible result</div><div style="height:600px"></div></div><div style="height:900px"></div>');
 const handle=await focusLocator(page,page.locator('#target'),{timeout:2000});
 await handle.dispose();
 const box=await page.locator('#target').boundingBox(),container=await page.locator('#container').boundingBox();
 assert.ok(box.y>=0&&box.y+box.height<=700);
 assert.ok(box.y>=container.y&&box.y+box.height<=container.y+container.height);
 await page.locator('#target').evaluate(node=>node.style.transform='translateX(80px)');
 await page.waitForFunction(()=>{
  const target=document.querySelector('#target').getBoundingClientRect();
  const ring=document.querySelector('qa-studio-locator-focus').shadowRoot.querySelector('[data-locator-focus]').getBoundingClientRect();
  return Math.abs(target.x-ring.x)<1&&Math.abs(target.y-ring.y)<1;
 });
 await clearLocatorFocus(page);
 assert.equal(await page.locator('[data-locator-focus]').count(),0);
});

test('focus bounds repeated detachments and preserves invalid-locator failures',async t=>{
 const {focusLocator}=await import('../locator-focus.mjs');
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent('<button>One</button><button>Two</button>');
 await assert.rejects(focusLocator(page,page.locator('button'),{timeout:200}),/strict mode violation/);
 const target=page.locator('button').first();
 target.scrollIntoViewIfNeeded=async()=>{throw new Error('Element is not attached to the DOM');};
 const start=Date.now();
 await assert.rejects(focusLocator(page,target,{timeout:200}),{name:'TimeoutError'});
 assert.ok(Date.now()-start<1500,'detachment retries share one bounded timeout');
});
