import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright';
import {executeStep, DebugSession} from '../runner.mjs';
import {screenshotPage} from '../locator-focus.mjs';
import {waitForPageReady} from '../page-readiness.mjs';

async function browserPage(t) {
  const browser=await chromium.launch();
  t.after(()=>browser.close());
  return browser.newPage();
}

test('navigation waits for delayed scripts, frames and images before validating or capturing',{timeout:15000},async t=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/image' || req.url==='/lazy'){
      res.setHeader('Content-Type','image/svg+xml');
      return setTimeout(()=>res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>'),450);
    }
    if(req.url==='/script'){
      res.setHeader('Content-Type','text/javascript');
      return setTimeout(()=>res.end('document.querySelector("#value").value="Loaded";'),350);
    }
    res.setHeader('Content-Type','text/html');
    if(req.url==='/frame')return setTimeout(()=>res.end('<p>Frame ready</p><img src="/image">'),250);
    res.end('<input id="value"><img src="/image"><iframe src="/frame"></iframe><div style="height:12000px"></div><img id="lazy" loading="lazy" src="/lazy"><script src="/script"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const page=await browserPage(t);
  await executeStep(page,{action:'navigate',value:'http://127.0.0.1:'+server.address().port},{timeoutMs:100});
  assert.equal(await page.locator('#value').inputValue(),'Loaded');
  assert.equal(await page.frames()[1].locator('img').evaluate(img=>img.complete && img.naturalWidth>0),true);
  const original=page.screenshot.bind(page);
  page.screenshot=async options=>{
    assert.equal(await page.locator('#lazy').evaluate(img=>img.complete && img.naturalWidth>0),true);
    return original(options);
  };
  const bytes=await screenshotPage(page,{fullPage:true});
  assert.ok(bytes.length>0);
  assert.equal(await page.locator('#lazy').getAttribute('loading'),'lazy');
});

test('loading indicators and late targets recover without submitting twice',{timeout:15000},async t=>{
  const page=await browserPage(t);
  await page.setContent('<main aria-busy="true"><p>Form</p><input required id="value"></main>');
  await page.evaluate(()=>setTimeout(()=>{
    document.querySelector('input').value='Ready';
    document.querySelector('main').removeAttribute('aria-busy');
  },450));
  await executeStep(page,{action:'uiValidate',value:''},{objects:[],timeoutMs:100});
  await page.evaluate(()=>{
    window.submissions=0;
    setTimeout(()=>{
      const button=document.createElement('button');button.id='submit';button.textContent='Submit';
      button.onclick=()=>window.submissions++;
      document.body.append(button);
    },450);
  });
  await executeStep(page,{action:'click',locatorType:'id',target:'submit',value:''},{objects:[],timeoutMs:100});
  assert.equal(await page.evaluate(()=>window.submissions),1);
  await page.evaluate(()=>{document.querySelector('input').value='Pending';setTimeout(()=>document.querySelector('input').value='Updated',600);});
  await executeStep(page,{action:'value',locatorType:'id',target:'value',value:'Updated'},{objects:[],timeoutMs:100});
});

test('readiness is bounded, ignores long-lived fetches, and preserves validation failures',{timeout:15000},async t=>{
  const page=await browserPage(t);
  await page.setContent('<div aria-busy="true">Loading</div>');
  await assert.rejects(waitForPageReady(page,{timeout:250}),/visible loading indicator/);
  await page.setContent('<p id="result">Wrong result</p>');
  await assert.rejects(executeStep(page,{action:'text',locatorType:'id',target:'result',value:'Expected result',timeoutMs:1000},{objects:[]}),/Expected result/);
  await page.route('https://background.test/events',()=>{});
  await page.evaluate(()=>{void fetch('https://background.test/events').catch(()=>{});});
  await waitForPageReady(page,{timeout:1000});
  await page.evaluate(()=>{document.querySelector('#result').textContent='Clock started';window.clockTicks=0;setInterval(()=>document.querySelector('#result').textContent=String(++window.clockTicks),25);});
  await waitForPageReady(page,{timeout:1000});
  assert.ok(await page.evaluate(()=>window.clockTicks>5));
  await page.close();
  await assert.rejects(waitForPageReady(page,{timeout:1000}),/Page closed/);
});

test('readiness includes shadow DOM and waits for fonts',{timeout:15000},async t=>{
  const page=await browserPage(t);
  await page.setContent('<div id="host"></div>');
  await page.evaluate(()=>{
    const shadow=document.querySelector('#host').attachShadow({mode:'open'});
    shadow.innerHTML='<div aria-busy="true">Loading</div>';
    setTimeout(()=>{shadow.innerHTML='<p>Shadow ready</p>';},400);
  });
  await waitForPageReady(page,{timeout:2000});
  assert.equal(await page.locator('#host p').textContent(),'Shadow ready');
  await page.evaluate(()=>{
    Object.defineProperty(document.fonts,'status',{configurable:true,get:()=>window.fontsReady?'loaded':'loading'});
    setTimeout(()=>window.fontsReady=true,300);
  });
  await waitForPageReady(page,{timeout:2000});
  assert.equal(await page.evaluate(()=>window.fontsReady),true);
});

test('debug reports an explicit screenshot failure and readiness stops on cancellation',{timeout:15000},async t=>{
  const page=await browserPage(t);
  await page.setContent('<p>Ready</p>');
  const step={action:'screenshot',status:'pending',value:''};
  const run={id:'capture',status:'running',startedAt:new Date().toISOString(),tests:[{id:'test',steps:[step]}],context:{objects:[]}};
  const debug=new DebugSession(run,page.context().browser(),page.context(),page,'.test-output');
  page.screenshot=async()=>{throw new Error('Image write failed');};
  await debug.step();
  assert.equal(run.status,'failed');
  assert.equal(step.status,'failed');
  assert.match(step.error,/requested screenshot could not be captured/);
  await page.setContent('<div aria-busy="true">Loading forever</div>');
  const waiting=waitForPageReady(page,{timeout:30000});
  const rejected=assert.rejects(waiting,/Page closed|Target page.*closed/);
  await page.close();
  await rejected;
});
