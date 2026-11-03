import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTestCases, generationOutputSchema, metadataFromInspection } from '../test-case-generator.mjs';

const input={requirement:'Customers can register. Only authenticated users can access account settings. Registration responds within 2 seconds.',moduleName:'Registration',pageMetadata:{fields:[{name:'Email',type:'email',constraints:{required:true}},{name:'Password',type:'password',constraints:{minLength:8,maxLength:64}},{name:'Age',type:'integer',constraints:{min:18,max:65}},{name:'Plan',type:'select',constraints:{options:['Basic','Premium']}}],controls:[{name:'Register',type:'submit'}]}};
test('local rules produce traceable scenarios for supplied constraints and every applicable category',()=>{
  const result=generateTestCases(input);assert.ok(generationOutputSchema.safeParse(result).success);
  assert.deepEqual(new Set(result.testCases.map(c=>c.category)),new Set(['Positive','Negative','Functional','Validation','Boundary','Security','Performance']));
  assert.ok(result.testCases.some(c=>c.category==='Validation'&&c.testData.some(d=>d.field==='Email'&&d.value==='')));
  for(const value of ['17','18','65','66'])assert.ok(result.testCases.some(c=>c.category==='Boundary'&&c.testData.some(d=>d.field==='Age'&&d.value===value)));
  for(const count of [7,8,64,65])assert.ok(result.testCases.some(c=>c.category==='Boundary'&&c.steps.some(s=>s.instruction.includes(`exactly ${count} characters`))));
  assert.ok(result.testCases.some(c=>c.category==='Performance'&&c.testData.some(d=>d.field==='responseTimeBudgetMs'&&d.value==='2000')));
  assert.ok(result.testCases.every(c=>c.requirementReference&&c.expectedResult&&c.steps.length));assert.equal(result.coverage.complete,false);
});
test('category selection narrows output without changing stable IDs; duplicate metadata and prose do not duplicate cases',()=>{
  const all=generateTestCases(input),limited=generateTestCases({...input,categories:['Boundary','Boundary']});
  assert.ok(limited.testCases.every(c=>c.category==='Boundary'));assert.deepEqual(limited.testCases,all.testCases.filter(c=>c.category==='Boundary'));
  const duplicated=generateTestCases({...input,pageMetadata:{...input.pageMetadata,fields:[...input.pageMetadata.fields,...input.pageMetadata.fields],controls:[...input.pageMetadata.controls,...input.pageMetadata.controls]}});
  assert.deepEqual(duplicated,all);assert.equal(new Set(all.testCases.map(c=>c.id)).size,all.testCases.length);
  const repeated=generateTestCases({requirement:'Email is required. Email is required.',categories:['Validation']});assert.equal(repeated.testCases.length,1);
});
test('unknown behavior stays generic and unsupported categories return no fabricated thresholds or scans',()=>{
  const result=generateTestCases({requirement:'Users can view a catalogue.',categories:['Boundary','Security','Performance']});
  assert.deepEqual(result.testCases,[]);assert.match(result.warnings.join(' '),/No applicable/);
  const generic=generateTestCases({requirement:'Users can view a catalogue.'});assert.ok(generic.testCases.every(c=>c.assumptions.length));assert.doesNotMatch(JSON.stringify(generic),/SQL injection|100 concurrent|2000 ms/);
  for(const requirement of ['The catalogue does not require authentication.','Unauthenticated users must be able to view the catalogue.','Unauthenticated users must not be denied access to the catalogue.','Not only authenticated users can view the catalogue.'])assert.deepEqual(generateTestCases({requirement,categories:['Security']}).testCases,[]);
  assert.equal(generateTestCases({requirement:'Unauthenticated users must not access account settings.',categories:['Security']}).testCases.length,1);
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Generator must be offline');};
  try{assert.ok(generateTestCases({...input,categories:['Security','Performance']}).testCases.length);}finally{globalThis.fetch=oldFetch;}
});
test('explicit prose constraints are parsed conservatively and conflicts produce marked scenarios',()=>{
  const result=generateTestCases({requirement:'Email is required. Email must be a valid email address. Password must have 8 to 64 characters. Age must be between 18 and 65.',categories:['Validation','Negative','Boundary']});
  assert.ok(result.testCases.some(c=>c.testData.some(d=>d.value==='not-an-email')));assert.ok(result.testCases.some(c=>c.testData.some(d=>d.value==='17')&&c.assumptions.some(a=>a.includes('precision'))));
  const mismatch=generateTestCases({requirement:'Email is required.',pageMetadata:{fields:[{name:'Email',constraints:{required:false}}]}});
  assert.ok(mismatch.testCases.some(c=>c.title==='Email: required value is missing'));assert.match(mismatch.warnings.join(' '),/required follows requirement description/);
  const impossible=generateTestCases({requirement:'Age must be between 65 and 18.'});
  assert.ok(impossible.testCases.some(c=>/review contradictory constraints/.test(c.title)));assert.ok(!impossible.testCases.some(c=>c.category==='Boundary'));
});
test('input bounds, invalid categories, unknown properties and contradictory numeric limits fail with value-free errors',()=>{
  for(const bad of [{requirement:''},{requirement:15},{requirement:'x'.repeat(10001)},{requirement:'Register',categories:[]},{requirement:'Register',categories:['not-a-category']},{requirement:'Register',pageMetadata:{fields:[{name:'Age',constraints:{min:30,max:20}}]}},{requirement:'Register',apiKey:'secret-value'}])assert.throws(()=>generateTestCases(bad),error=>/Invalid generation input/.test(error.message)&&!error.message.includes('secret-value'));
  const ambiguous=generateTestCases({requirement:'Register',pageMetadata:{controls:[{name:'Save',disabled:true},{name:'Save',disabled:false}]}});
  assert.ok(ambiguous.testCases.some(c=>/review conflicting control definitions/.test(c.title)));assert.ok(!ambiguous.testCases.some(c=>c.title==='Save: disabled control'));
});
test('large boundaries use descriptors; hostile patterns are not executed; case limits are disclosed',()=>{
  const result=generateTestCases({requirement:'Verify supplied fields.',pageMetadata:{fields:[{name:'Description',constraints:{maxLength:1000000,pattern:'(a+)+$'}}]},categories:['Boundary','Validation']});
  assert.ok(result.testCases.some(c=>c.testData.some(d=>d.value==='<string of exactly 1000001 characters>')));assert.ok(result.testCases.some(c=>c.assumptions.some(a=>a.includes('does not execute patterns'))));
  const many=generateTestCases({requirement:'Validate fields.',pageMetadata:{fields:Array.from({length:100},(_,i)=>({name:'Field '+i,constraints:{minLength:1,maxLength:2}}))},categories:['Boundary']});
  assert.equal(many.testCases.length,200);assert.equal(many.coverage.limitReached,true);
  const long=generateTestCases({requirement:'x'.repeat(10000)});assert.ok(long.testCases.length);
  const merged=generateTestCases({requirement:'Extra is required.',pageMetadata:{fields:Array.from({length:100},(_,i)=>({name:'Field '+i}))},categories:['Positive']});
  assert.equal(merged.testCases[0].testData.length,100);assert.equal(merged.coverage.limitReached,true);assert.match(merged.warnings.join(' '),/first 100 distinct fields/);
});
test('browser inspection is adapted to the same optional metadata contract without entered values',()=>{
  const adapted=metadataFromInspection({context:{pages:[{controls:[{tag:'input',label:'Email',type:'email',required:true,minLength:null,maxLength:'80',value:'secret'},{tag:'button',label:'Send',type:'submit'}]}]}});
  assert.deepEqual(adapted.pageMetadata.fields,[{name:'Email',type:'email',constraints:{required:true,maxLength:80}}]);assert.doesNotMatch(JSON.stringify(adapted),/secret/);
  assert.ok(generateTestCases({requirement:'Submit an email.',pageMetadata:adapted.pageMetadata}));
  const disabled=metadataFromInspection({pages:[{controls:[{tag:'input',label:'Locked value',disabled:true}]}]});assert.equal(disabled.pageMetadata.fields.length,0);assert.match(disabled.warnings.join(' '),/Disabled/);
  const buttons=metadataFromInspection({pages:[{controls:[{tag:'input',label:'Submit',type:'submit'},{tag:'input',label:'Amount',type:'number',min:'1',step:'0.1'}]}]});assert.equal(buttons.pageMetadata.fields.length,1);assert.equal(buttons.pageMetadata.fields[0].constraints.step,0.1);assert.equal(buttons.pageMetadata.controls[0].type,'submit');
});
