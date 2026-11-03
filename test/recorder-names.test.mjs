import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticallyNameRecordedStep, recordedStepName } from '../recorder-names.mjs';
import { mapStepToRequirement } from '../model.mjs';
import { launchBrowser } from '../browsers.mjs';
import { installRecorder } from '../recorder.mjs';

test('recorded actions have readable names without entered values or technical identifiers', () => {
  const description = {label:'Email address',kind:'field'};
  assert.equal(recordedStepName({action:'fill',value:'private@example.com'},description),'Enter text in the “Email address” field');
  assert.equal(recordedStepName({action:'fill',value:''},description),'Clear the “Email address” field');
  assert.equal(recordedStepName({action:'fill',value:'secret',secret:true},{kind:'password field'}),'Enter the password in the password field');
  assert.equal(recordedStepName({action:'click'},{identifier:'submitOrder'}),'Click the “Submit order” element');
  assert.equal(recordedStepName({action:'click'},{identifier:':r18:',kind:'button'}),'Click the button');
  assert.equal(recordedStepName({action:'click'},{identifier:'control_123456789',kind:'button'}),'Click the button');
  assert.equal(recordedStepName({action:'doubleClick'},{label:'Order details'}),'Double-click the “Order details” element');
  assert.equal(recordedStepName({action:'select'},{label:'Country',selectedLabels:['United States','Canada']}),'Select “United States, Canada” from the “Country” dropdown');
  assert.equal(recordedStepName({action:'check'},{label:'Accept terms'}),'Select the “Accept terms” checkbox');
  assert.equal(recordedStepName({action:'uncheck'},{label:'Accept terms'}),'Clear the “Accept terms” checkbox');
  assert.equal(recordedStepName({action:'pressKey',value:'Control+Enter'},{label:'Search'}),'Press Control+Enter in the “Search” element');
  assert.equal(recordedStepName({action:'uploadFile'},{label:'Resume'}),'Upload a file using the “Resume” file upload field');
  assert.equal(recordedStepName({action:'visible'},{label:'Welcome message'}),'Verify that the “Welcome message” element is visible');
  assert.equal(recordedStepName({action:'text'},{label:'Welcome message'}),'Verify the text in the “Welcome message” element');
  assert.equal(recordedStepName({action:'value'},description),'Verify the value in the “Email address” field');
  assert.equal(recordedStepName({action:'navigate'},{pageTitle:'Customer portal'}),'Open the “Customer portal” page');
});

test('requirement names preserve replay data and restore readable names when unmapped', () => {
  const requirements = [
    {id:'open',instruction:'Open the Customer portal'},
    {id:'email',instruction:'Enter the email address for the account'},
    {id:'verify-email',instruction:'Verify the email address is correct'},
    {id:'submit',instruction:'Click Sign in to access the account'},
  ];
  const input = {action:'fill',target:'[id="auto-194812"]',value:'a@example.com',valueMode:'static',pageIndex:1,framePath:['iframe']};
  const mapped = automaticallyNameRecordedStep(input,requirements,{label:'Email address'});
  assert.equal(mapped.qaRequirementId,'email');
  assert.equal(mapped.name,'Enter text in the “Email address” text field — '+requirements[1].instruction);
  assert.deepEqual({...mapped,name:undefined,unmappedName:undefined,qaRequirementId:undefined,recordedName:undefined},{...input,name:undefined,unmappedName:undefined,qaRequirementId:undefined,recordedName:undefined});
  assert.equal(mapStepToRequirement(mapped,requirements,null).name,'Enter text in the “Email address” text field');
  assert.equal(automaticallyNameRecordedStep({action:'value'},requirements,{label:'Email address'}).qaRequirementId,'verify-email');
  assert.equal(automaticallyNameRecordedStep({action:'navigate'},requirements,{pageTitle:'Customer portal'}).qaRequirementId,'open');
  const manual = {...mapped,name:'Manual requirement',qaRequirementId:'manual'};
  assert.deepEqual(automaticallyNameRecordedStep(manual,requirements,{label:'Email address'}),manual);
});

test('unrelated, missing and ambiguous requirements keep readable action names', () => {
  const step = {action:'fill',value:'Alex'}, description = {label:'Your name'};
  for (const requirements of [[],[{id:'r',instruction:'Click Continue'}],[{id:'r',instruction:'Verify your name is displayed'}],
    [{id:'r1',instruction:'Enter your name as Alex'},{id:'r2',instruction:'Enter your name as Sam'}]]) {
    const result = automaticallyNameRecordedStep(step,requirements,description);
    assert.equal(result.qaRequirementId,undefined);
    assert.equal(result.name,'Enter text in the “Your name” text field');
  }
  const combined = [{id:'login',instruction:'Enter your email and password'}];
  for (const label of ['Email','Password']) assert.equal(automaticallyNameRecordedStep(step,combined,{label}).qaRequirementId,'login');
});

test('browser capture uses labels, accessible names and option text instead of generated IDs', {timeout:30000}, async t => {
  const browser = await launchBrowser('chrome');
  t.after(()=>browser.close());
  const page = await browser.newPage(), captures = [];
  await page.exposeFunction('__studioMode',()=> 'actions');
  await page.exposeFunction('__studioRecord',input=> {captures.push(input);return {captured:true};});
  await page.setContent('<label for="generated_123456">Email address</label><input id="generated_123456">'+
    '<span id="password-label">Account password</span><input type="password" aria-labelledby="password-label">'+
    '<input placeholder="Search products"><label>Country<select><option value="us">United States</option><option value="ca">Canada</option></select></label>'+
    '<button id="generated_987654"><span>Save changes</span></button><div id="shadow"></div>');
  await page.evaluate(installRecorder);
  await page.evaluate(()=>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span id="shadow-label">Display name</span><input aria-labelledby="shadow-label">');
  await page.getByLabel('Email address').fill('private@example.com');
  await page.getByLabel('Account password').fill('do-not-copy-this-secret');
  await page.getByPlaceholder('Search products').fill('Laptop');
  await page.getByLabel('Country').selectOption('ca');
  await page.getByRole('button',{name:'Save changes'}).locator('span').click();
  await page.getByLabel('Display name').fill('Alex');
  await page.evaluate(()=>window.__studioRecord({action:'barrier'}));
  const names=captures.filter(c=>c.action!=='barrier').map(c=>recordedStepName(c,c.description));
  for(const name of ['Enter text in the “Email address” text field','Enter the password in the “Account password” password field','Enter text in the “Search products” text field',
    'Select “Canada” from the “Country” dropdown','Click the “Save changes” button','Enter text in the “Display name” text field']) assert.ok(names.includes(name),name);
  assert.ok(!JSON.stringify(captures).includes('do-not-copy-this-secret'));
  assert.ok(!JSON.stringify(names).includes('generated_'));
});

test('click and verification names include visible text and native or ARIA element types', {timeout:30000}, async t => {
  const browser=await launchBrowser('chrome');t.after(()=>browser.close());
  const page=await browser.newPage(), captures=[];
  await page.exposeFunction('__studioMode',()=> 'actions');
  await page.exposeFunction('__studioRecord',input=> {captures.push(input);return {captured:true};});
  await page.setContent('<a href="#help"><span>Help center</span></a><button><img alt="Download invoice"></button>'+
    '<input type="submit" value="Place order"><div role="tab"><span>Billing</span></div>'+
    '<h2>Welcome back</h2><p>Order saved successfully</p><img alt="Company logo">'+
    '<table><tr><td>Approved</td></tr></table><div role="alert">Payment declined</div>'+
    '<label>Comments<textarea>private initial content</textarea></label><label>Accept terms<input type="checkbox"></label>'+
    '<label>Receipt<input type="file"></label><div id="custom">Custom text</div>');
  await page.evaluate(installRecorder);
  await page.getByRole('link',{name:'Help center'}).locator('span').click();
  await page.getByRole('button',{name:'Download invoice'}).click();
  await page.getByRole('button',{name:'Place order'}).click();
  await page.getByRole('tab',{name:'Billing'}).locator('span').click();
  await page.getByLabel('Comments').fill('private edited content');
  await page.getByLabel('Accept terms').check();
  await page.locator('#custom').click();
  await page.evaluate(()=>window.__studioRecorderMode='text');
  await page.getByRole('heading',{name:'Welcome back'}).click();
  await page.getByText('Order saved successfully',{exact:true}).click();
  await page.getByRole('cell',{name:'Approved'}).click();
  await page.evaluate(()=>window.__studioRecorderMode='visible');
  await page.getByRole('img',{name:'Company logo'}).evaluate(el=>el.click());
  await page.getByRole('alert').click();
  await page.getByLabel('Receipt').evaluate(el=>el.click());
  await page.evaluate(()=>window.__studioRecorderMode='value');
  await page.getByLabel('Comments').click();
  await page.evaluate(()=>window.__studioRecord({action:'barrier'}));
  const names=captures.filter(c=>c.action!=='barrier').map(c=>recordedStepName(c,c.description));
  for(const name of ['Click the “Help center” link','Click the “Download invoice” button','Click the “Place order” button',
    'Click the “Billing” tab','Enter text in the “Comments” text area','Select the “Accept terms” checkbox',
    'Click the “Custom text” element','Verify the text in the “Welcome back” heading',
    'Verify the text in the “Order saved successfully” paragraph','Verify the text in the “Approved” table cell',
    'Verify that the “Company logo” image is visible','Verify that the “Payment declined” alert is visible',
    'Verify that the “Receipt” file upload field is visible','Verify the value in the “Comments” text area']) assert.ok(names.includes(name),name+'; captured: '+names.join('; '));
  assert.ok(!JSON.stringify(names).includes('private'));
});
