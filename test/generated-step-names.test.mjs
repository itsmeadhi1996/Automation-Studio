import test from 'node:test';
import assert from 'node:assert/strict';
import {nameGeneratedSteps} from '../generated-step-names.mjs';
import {automationProject} from '../automation-model.mjs';

test('generated login steps use readable actions and visible control labels',()=>{
  const steps=[
    {action:'navigate',name:'Step 1',value:'https://example.test/login'},
    {action:'fill',name:'fill_username',locatorType:'name',target:'username',value:'ACCOUNT_USER',valueMode:'environment'},
    {action:'fill',name:'Step 3',locatorType:'name',target:'password',value:'secret-test-password',sensitive:true},
    {action:'click',name:'Click #generated_12345',locatorType:'css',target:'#generated_12345'},
    {action:'visible',name:'Step 5',locatorType:'text',target:'Dashboard'}
  ];
  const before=structuredClone(steps);
  const inspection={title:'OrangeHRM',elements:[
    {tag:'input',label:'Username',locatorType:'name',target:'username'},
    {tag:'input',type:'password',label:'Password',locatorType:'name',target:'password'},
    {tag:'button',text:'Login',locatorType:'css',target:'#generated_12345'}
  ]};
  const named=nameGeneratedSteps(steps,{inspection});
  assert.deepEqual(named.map(s=>s.name),['Open the “OrangeHRM” page','Enter the username','Enter the password','Click the “Login” button','Verify that the “Dashboard” element is visible']);
  assert.doesNotMatch(JSON.stringify(named.map(s=>s.name)),/ACCOUNT_USER|secret-test-password|generated_12345/);
  for(let i=0;i<steps.length;i++)assert.deepEqual({...named[i],name:steps[i].name,elementName:undefined},{...steps[i],elementName:undefined});
  assert.deepEqual(steps,before);
});

test('generated names keep descriptive wording and hide input values from titles',()=>{
  const named=nameGeneratedSteps([
    {action:'visible',name:'Verify that the dashboard is displayed',locatorType:'text',target:'Dashboard'},
    {action:'fill',name:'Enter secret-password in the password field',value:'secret-password',locatorType:'name',target:'password'},
    {action:'click',name:'Click btnLogin',locatorType:'id',target:'btnLogin'},
    {action:'fill',name:'Step 4',locatorType:'css',target:'input[name="username"]',value:'Alex'}
  ]);
  assert.equal(named[0].name,'Verify that the dashboard is displayed');
  assert.equal(named[1].name,'Enter the password');
  assert.doesNotMatch(named[2].name,/btnLogin/);
  assert.equal(named[3].name,'Enter the username');
});

test('other generated browser actions have plain-English fallback names',()=>{
  const actions=['hover','hidden','heading','url','dateOnly','dateTime','wait','screenshot','uiValidate'];
  const names=nameGeneratedSteps(actions.map(action=>({action,name:'Step 1'}))).map(s=>s.name);
  assert.deepEqual(names,['Move the pointer over the page element','Verify that the page element is no longer visible','Verify the page heading','Verify that the expected page is open','Choose a date in the date field','Choose a date and time in the date and time field','Wait for the page to be ready','Take a screenshot of the page','Verify that the page looks as expected']);
});

test('existing generic step names display clearly without changing stored data or custom names',()=>{
  const project={objects:[],tests:[{id:'case',tcNumber:1,steps:[
    {action:'fill',name:'Step 1',locatorType:'name',target:'username',value:'USER',valueMode:'environment'},
    {action:'click',name:'My carefully written instruction',locatorType:'css',target:'button'},
    {action:'visible',name:'QA requirement wording',qaRequirementId:'req-1',locatorType:'text',target:'Dashboard'}
  ]}]};
  const before=structuredClone(project);
  const display=automationProject(project);
  assert.equal(display.tests[0].steps[0].name,'Enter the username');
  assert.equal(display.tests[0].steps[1].name,'My carefully written instruction');
  assert.equal(display.tests[0].steps[2].name,'QA requirement wording');
  assert.equal(display.tests[0].steps[2].qaRequirementId,'req-1');
  assert.deepEqual(project,before);
});
