import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { OpenVpnConnect } from '../vpn.mjs';
import { createStudio } from './support.mjs';

function fixture() {
  const calls = [];
  const vpn = new OpenVpnConnect({ platform: 'win32', executable: 'C:/OpenVPN/OpenVPNConnect.exe', exists: async () => {}, run: async (exe,args,options) => {
    calls.push({ exe,args,options });
    return { stdout: args[0]==='--list-profiles' ? JSON.stringify([{id:'123',name:'Office VPN',type:'user-locked',password:'never-return-this',username:'private-user'}]) : '' };
  } });
  return { vpn, calls };
}

test('OpenVPN adapter selects existing profiles, bounds commands and never claims connectivity', async () => {
  const { vpn, calls } = fixture();
  assert.deepEqual(await vpn.profiles(), [{ id:'123',name:'Office VPN',type:'user-locked' }]);
  await vpn.action('connect','123');
  assert.deepEqual(calls.at(-1).args,['--connect-shortcut=123']);
  assert.equal(calls.at(-1).options.windowsHide,true);
  assert.equal((await vpn.status()).tunnelStatus,'unknown');
  assert.equal((await vpn.status()).lastAction.action,'connect');
  await vpn.action('disconnect');
  assert.deepEqual(calls.at(-1).args,['--disconnect-shortcut']);
  await assert.rejects(vpn.action('connect','123; calc.exe'), /Select an OpenVPN profile/);
  await assert.rejects(vpn.action('connect','removed'), /no longer exists/);
  assert.equal(vpn.busy,false);
});

test('OpenVPN handles missing installs, consent, native failures, and concurrent requests', async () => {
  const { vpn } = fixture();
  vpn.exists=async()=>{throw new Error('missing');};
  await assert.rejects(vpn.profiles(),/not found/);
  vpn.exists=async()=>{};
  vpn.run=async()=>({stdout:JSON.stringify({status:'error',error:'Accept GDPR to use the application.'})});
  await assert.rejects(vpn.profiles(),/first-run consent/);
  vpn.run=async()=>{throw Object.assign(new Error('secret command output'),{code:'ETIMEDOUT'});};
  await assert.rejects(vpn.action('connect','123'), /did not respond/);
  assert.equal(vpn.busy,false);
  let release;
  vpn.run=()=>new Promise(resolve=>{release=()=>resolve({stdout:''});});
  const pending=vpn.action('disconnect');
  await assert.rejects(vpn.action('disconnect'),/already in progress/);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  release();await pending;
});

test('OpenVPN UI discovers profiles, saves selection, requests actions, and persists no credentials', {timeout:60000}, async t => {
  const {vpn,calls}=fixture();
  const port=3230,base=`http://127.0.0.1:${port}`,storage=path.resolve('.test-output',`vpn-${Date.now()}`);
  let studio=await createStudio({port,storage,vpn});await studio.listen();
  const browser=await chromium.launch();
  t.after(async()=>{await browser.close();await studio?.close();});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/automation');
  await page.getByRole('button',{name:'OpenVPN',exact:true}).click();
  await page.locator('#vpn-profile option[value="123"]').waitFor({state:'attached'});
  await page.locator('#vpn-profile').selectOption('123');
  await page.getByRole('button',{name:'Save profile selection',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-action="vpn-connect"]').disabled);
  await page.getByRole('button',{name:'Connect saved profile'}).click();
  await page.getByText(/Connection requested at/).waitFor();
  assert.ok(calls.some(c=>c.args[0]==='--connect-shortcut=123'));
  await page.getByRole('button',{name:'Disconnect VPN',exact:true}).click();
  await page.getByText(/Disconnection requested at/).waitFor();
  assert.deepEqual(calls.at(-1).args,['--disconnect-shortcut']);
  const saved=JSON.parse(await readFile(path.join(storage,'data/studio.json'),'utf8'));
  assert.deepEqual(saved.vpn,{profileId:'123'});
  assert.ok(!JSON.stringify(saved).includes('never-return-this'));
  const denied=await fetch(base+'/api/vpn/connect',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:'{}'});
  assert.equal(denied.status,403);
  vpn.busy=true;
  const project=studio.store.projects[0];
  const blocked=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,testId:project.tests[0].id})});
  assert.equal(blocked.status,409);
  vpn.busy=false;
  await studio.close();studio=null;
  studio=await createStudio({port,storage,vpn});await studio.listen();
  assert.equal((await(await fetch(base+'/api/vpn')).json()).profileId,'123');
  assert.deepEqual(errors,[]);
});
