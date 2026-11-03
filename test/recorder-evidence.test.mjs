import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {startRecording} from '../recorder.mjs';

test('assertion screenshots locate scrolled and framed targets, mask secrets, and report image failures', {timeout:30000}, async t=>{
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.url==='/frame') return res.end('<button id="frame-target">Visible inside a frame</button><input type="password" id="frame-secret" value="private-in-frame">');
    res.end('<style>body{margin:0}#spacer{height:1400px}#target{width:200px;height:50px;margin:20px}input{width:200px;height:30px}iframe{width:600px;height:150px;display:block;margin:20px}</style><div id="spacer"></div><div id="target">Expected value</div><input id="secret" type="password" value="do-not-capture"><iframe src="/frame"></iframe>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const artifacts=path.resolve('.test-output','recorder-evidence-'+Date.now());
  const session=await startRecording({id:'p',browser:'chrome',tests:[{id:'t',name:'Evidence'}]},'t','http://127.0.0.1:'+server.address().port,{headless:true,artifacts});
  t.after(()=>session.stop());
  const page=session.page;
  const readPixels=async(file,points)=>{
    const bytes=await readFile(path.join(artifacts,file));
    return page.evaluate(async({url,points})=>{
      const img=new Image();img.src=url;await img.decode();
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      return {width:img.width,height:img.height,colors:points.map(({x,y})=>[...ctx.getImageData(Math.floor(x),Math.floor(y),1,1).data])};
    },{url:'data:image/png;base64,'+bytes.toString('base64'),points});
  };
  await page.evaluate(()=>window.__studioRecorderMode='text');
  await page.locator('#target').click();
  await page.getByRole('status').filter({hasText:'Text captured successfully'}).waitFor();
  const targetBox=await page.locator('#target').boundingBox();
  const passwordBox=await page.locator('#secret').boundingBox();
  const screenshot=session.steps.at(-1).captureScreenshot;
  const pixels=await readPixels(screenshot,[{x:targetBox.x+1,y:targetBox.y+25},{x:passwordBox.x+20,y:passwordBox.y+15}]);
  assert.deepEqual([pixels.width,pixels.height],[1440,900]);
  assert.deepEqual(pixels.colors[0].slice(0,3),[229,72,77],'Red outline must surround the assertion target');
  assert.deepEqual(pixels.colors[1].slice(0,3),[255,0,255],'Passwords must be masked');
  const frame=page.frames().find(item=>item.url().endsWith('/frame'));
  await frame.evaluate(()=>window.__studioRecorderMode='visible');
  await frame.locator('#frame-target').click();
  await frame.getByRole('status').filter({hasText:'Visible element captured'}).waitFor();
  const frameBox=await frame.locator('#frame-target').boundingBox(),secretBox=await frame.locator('#frame-secret').boundingBox();
  const frameStep=session.steps.at(-1);
  assert.ok(frameStep.framePath.length);
  const framePixels=await readPixels(frameStep.captureScreenshot,[{x:frameBox.x+1,y:frameBox.y+frameBox.height/2},{x:secretBox.x+10,y:secretBox.y+secretBox.height/2}]);
  assert.deepEqual(framePixels.colors[0].slice(0,3),[229,72,77]);
  assert.deepEqual(framePixels.colors[1].slice(0,3),[255,0,255]);
  const original=page.screenshot.bind(page);
  page.screenshot=async()=>{throw new Error('Simulated image write failure');};
  await page.locator('#target').click();
  await page.getByRole('status').filter({hasText:'screenshot could not be saved'}).waitFor();
  assert.equal(session.steps.at(-1).action,'text');
  assert.equal(session.steps.at(-1).captureScreenshot,undefined);
  assert.ok(session.warnings.some(item=>item.includes('Simulated image write failure')));
  page.screenshot=original;
  console.log('Screenshot evidence checked in '+artifacts);
});

