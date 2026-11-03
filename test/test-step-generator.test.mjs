import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRequirementTestSteps, inspectedNavigationLinks, testStepOutputSchema } from '../test-step-generator.mjs';

const requirement={url:'https://example.test/login',description:'Open the app with valid credentials, click Leave from the Dashboard button, verify the page is redirected to the Leaves page.'};
const candidate={name:'Open Leave from Dashboard',qa:{category:'Positive',expectedResult:'The Leaves page is displayed.',manualSteps:[{instruction:'Exercise a valid example of the supplied requirement.',expectedResult:'The Leaves page is displayed.'}]}};

test('supplied Leave workflow becomes separate open, sign-in, click and redirect instructions',()=>{
  const result=generateRequirementTestSteps(requirement,candidate);assert.ok(testStepOutputSchema.safeParse(result).success);
  assert.deepEqual(result.steps.map(step=>step.instruction),['Open the application at https://example.test/login.','Sign in with valid test credentials.','On the Dashboard, click Leave.','Verify that the Leaves page is displayed.']);
  assert.ok(result.steps.every(step=>step.expectedResult));assert.match(result.warnings.join(' '),/No sign-in, navigation or test execution/);
  assert.deepEqual(generateRequirementTestSteps(requirement,candidate),result);
  const ordinaryLanguage=generateRequirementTestSteps({...requirement,description:'The user logs in with valid credentials and clicks Leave from the Dashboard button. The page is redirected to the Leaves page.'},candidate);
  assert.deepEqual(ordinaryLanguage.steps,result.steps);
});

test('workflow details override navigation for the selected case without hardcoded pages or invented controls',()=>{
  const result=generateRequirementTestSteps({...requirement,url:'https://example.test',description:'Users can view invoices.'},{...candidate,name:'View invoices',qa:{...candidate.qa,expectedResult:'The Invoices page is displayed.'}},'Click Billing on the Home page. Verify the page is redirected to the Invoices page.');
  assert.match(result.steps.map(step=>step.instruction).join(' '),/Home.*Billing/);assert.match(result.steps.at(-1).instruction,/Invoices/);assert.doesNotMatch(JSON.stringify(result),/Dashboard|Leave\./);
  const unknown=generateRequirementTestSteps({url:'https://example.test',description:'Users can view records.'},{name:'View records',qa:{category:'Positive',manualSteps:[],expectedResult:'Records are visible.'}});
  assert.match(unknown.warnings.join(' '),/navigation path is missing/);assert.doesNotMatch(unknown.steps.map(step=>step.instruction).join(' '),/Dashboard|Leaves page|Sign in/);
});

test('observed links supply actual navigation URLs and unsafe or secret-bearing links are not cached',()=>{
  const page={url:'https://example.test/dashboard',title:'Dashboard',controls:[{label:'Leave',href:'/leaves'},{label:'Another site',href:'https://elsewhere.test'},{label:'Private',href:'/page?token=private-value'},{label:'Disabled',href:'/disabled',disabled:true},{label:'Script',href:'javascript:alert(1)'}]};
  const links=inspectedNavigationLinks(page);assert.deepEqual(links,[{name:'Leave',url:'https://example.test/leaves'}]);
  const result=generateRequirementTestSteps({url:page.url,description:'Users can view the Leave page.',generation:{pages:[{...page,links}]}},{name:'View Leave',qa:{category:'Positive',expectedResult:'The Leave page is available.',manualSteps:[]}});
  assert.ok(result.steps.some(step=>step.instruction==='On the Dashboard, click Leave.'));assert.ok(result.steps.some(step=>step.instruction.includes('https://example.test/leaves')));assert.doesNotMatch(JSON.stringify(result),/private-value|elsewhere|javascript/);
  const duplicate={...requirement,generation:{pages:[{title:'Dashboard',links:[{name:'Leave',url:'https://example.test/employee/leaves'},{name:'Leave',url:'https://example.test/team/leaves'}]}]}};
  const ambiguous=generateRequirementTestSteps(duplicate,candidate);assert.match(ambiguous.warnings.join(' '),/More than one destination/);assert.ok(!ambiguous.steps.some(step=>/employee\/leaves|team\/leaves/.test(step.expectedResult)));
});

test('credential validation checks invalid inputs without signing in successfully first',()=>{
  const result=generateRequirementTestSteps({...requirement,pageMetadata:{controls:[{name:'Sign in',type:'submit'}]}},{name:'Email: reject invalid email',qa:{category:'Negative',expectedResult:'The email address is rejected.',testData:[{field:'Email',value:'not-an-email'}],manualSteps:[]}});
  assert.ok(result.steps.some(step=>step.instruction==='Enter "not-an-email" in Email.'));assert.ok(result.steps.some(step=>step.instruction==='Click Sign in to attempt the workflow.'));
  assert.doesNotMatch(result.steps.map(step=>step.instruction).join(' '),/valid test credentials|Dashboard|Leaves page/);assert.equal(result.steps.at(-1).expectedResult,'The email address is rejected.');
});

test('existing detailed cases and security/performance scenarios keep their authored actions',()=>{
  const steps=[{instruction:'Open the supplied sign-in page.',expectedResult:'The form appears.'},{instruction:'Enter the approved test data.',expectedResult:'The fields contain the data.'}];
  assert.deepEqual(generateRequirementTestSteps(requirement,{name:'Existing case',qa:{manualSteps:steps}}).steps,steps);
  for(const category of ['Security','Performance']){
    const result=generateRequirementTestSteps(requirement,{name:'Review a controlled scenario',qa:{category,manualSteps:steps}});assert.deepEqual(result.steps,steps);assert.match(result.warnings.join(' '),/does not perform a security scan or load test/);
  }
});

test('generation preserves ordered repeated navigation, bounds long workflows and stays offline',()=>{
  const old=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Step generation must be offline');};
  try{
    const loop=generateRequirementTestSteps(requirement,candidate,'Click Leave. Click Dashboard. Click Leave.');assert.equal(loop.steps.filter(step=>step.instruction==='Click Leave.').length,2);
    const long=generateRequirementTestSteps(requirement,candidate,Array.from({length:60},(_,i)=>`Click Item ${i}.`).join(' '));assert.equal(long.steps.length,50);assert.match(long.warnings.join(' '),/first 50 steps/);
    assert.throws(()=>generateRequirementTestSteps(requirement,candidate,'x'.repeat(10001)),error=>/Workflow details/.test(error.userMessage));
  }finally{globalThis.fetch=old;}
});
