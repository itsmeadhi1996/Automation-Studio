import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTestCases, generationOutputSchema } from '../test-case-generator.mjs';

test('explicit description overrides stale bounds, field types and required flags without mutating metadata',()=>{
  const input={requirement:'Email is required. Email must be a valid email address. Password must have 8 to 64 characters.',pageMetadata:{fields:[{name:'Email',type:'url',constraints:{required:false}},{name:'Password',type:'password',constraints:{minLength:2,maxLength:6}}]}};
  const before=structuredClone(input),result=generateTestCases(input);assert.deepEqual(input,before);assert.ok(generationOutputSchema.safeParse(result).success);
  assert.ok(result.testCases.some(c=>c.title==='Email: required value is missing'));assert.ok(result.testCases.some(c=>c.title==='Email: reject invalid email'));assert.ok(!result.testCases.some(c=>c.title==='Email: reject invalid url'));
  for(const size of [7,8,64,65])assert.ok(result.testCases.some(c=>c.category==='Boundary'&&c.steps[0].instruction.includes(`exactly ${size} characters`)));
  assert.ok(!result.testCases.some(c=>c.category==='Boundary'&&c.steps[0].instruction.includes('exactly 6 characters')));
  assert.ok(result.testCases.filter(c=>c.testData.some(d=>d.field==='Email')).every(c=>c.assumptions.some(a=>a.includes('Constraint reconciliation'))));
  assert.match(result.warnings.join(' '),/follows requirement description/);
  assert.deepEqual(generateTestCases(input),result);
});

test('compatible repeated bounds intersect and numeric declarations preserve integer precision rules',()=>{
  const input={requirement:'Age must be between 18 and 65. Age must be between 21 and 60.',pageMetadata:{fields:[{name:'Age',type:'integer'}]},categories:['Boundary','Negative']};
  const result=generateTestCases(input);
  for(const value of ['20','21','60','61'])assert.ok(result.testCases.some(c=>c.testData.some(d=>d.field==='Age'&&d.value===value)));
  assert.ok(result.testCases.some(c=>c.title==='Age: reject invalid integer'));
  assert.ok(!result.testCases.some(c=>c.testData.some(d=>d.value==='18')));assert.match(result.warnings.join(' '),/strictest supplied bound/);
  const filtered=generateTestCases({...input,categories:['Boundary']});assert.deepEqual(filtered.testCases,result.testCases.filter(c=>c.category==='Boundary'));
});

test('contradictory same-source rules become review cases and unaffected fields still generate',()=>{
  const result=generateTestCases({requirement:'Age must be between 18 and 20. Age must be between 30 and 40. Email is required.',pageMetadata:{fields:[{name:'Contact',type:'email',constraints:{options:['a'],pattern:'first'}},{name:'Contact',type:'url',constraints:{options:['b'],pattern:'second'}}]}});
  for(const name of ['Age','Contact'])assert.ok(result.testCases.some(c=>c.title===`${name}: review contradictory constraints`&&c.priority==='high'));
  assert.ok(result.testCases.some(c=>c.title==='Email: required value is missing'));
  assert.ok(!result.testCases.some(c=>c.category==='Boundary'&&c.testData.some(d=>d.field==='Age')));
  assert.ok(!result.testCases.some(c=>c.category==='Negative'&&c.testData.some(d=>d.field==='Contact')));
  assert.ok(!result.testCases.some(c=>c.title==='Contact: enforce the supplied pattern'));
  assert.match(result.warnings.join(' '),/no compatible range/);assert.equal(result.coverage.complete,false);
});

test('cross-source contradictory ranges omit only the lower-priority rule',()=>{
  const result=generateTestCases({requirement:'Password must have at least 8 characters.',pageMetadata:{fields:[{name:'Password',constraints:{maxLength:6}}]},categories:['Boundary']});
  assert.equal(result.testCases.length,2);assert.ok(result.testCases.every(c=>/minLength/.test(c.expectedResult)));assert.match(result.warnings.join(' '),/maxLength from lower-priority metadata was omitted/);
  const metadata=generateTestCases({requirement:'Verify age.',pageMetadata:{constraints:['Age must be between 18 and 65.'],fields:[{name:'Age',constraints:{min:80,max:90}}]},categories:['Boundary']});
  for(const value of ['17','18','65','66'])assert.ok(metadata.testCases.some(c=>c.testData.some(d=>d.value===value)));assert.match(metadata.warnings.join(' '),/follows page constraints/);
});

test('contradictory control states require review without asserting an enabled or disabled action',()=>{
  const result=generateTestCases({requirement:'Save the profile.',pageMetadata:{controls:[{name:'Save',type:'button',disabled:false},{name:'Save',type:'submit',disabled:true}]}});
  assert.ok(result.testCases.some(c=>c.title==='Save: review conflicting control definitions'));
  assert.ok(!result.testCases.some(c=>['Save: disabled control','Save: stated workflow action'].includes(c.title)));assert.match(result.warnings.join(' '),/conflicting type\/disabled/);
});

test('many conflicts remain bounded, keep diagnostic notes and do not block future generation',()=>{
  const fields=Array.from({length:40},(_,i)=>({name:`Field ${i}`,constraints:{maxLength:2}}));
  const result=generateTestCases({requirement:fields.map(f=>`${f.name} must have at least 8 characters.`).join(' '),pageMetadata:{fields}});
  assert.ok(generationOutputSchema.safeParse(result).success);assert.ok(result.testCases.every(c=>c.assumptions.length<=20));assert.ok(result.warnings.length<=30);assert.match(result.warnings.join(' '),/first 20 reconciliation notes/);
  const positive=result.testCases.find(c=>c.category==='Positive');assert.ok(positive.assumptions.at(-1).includes('Additional assumptions'));
  const badProse=generateTestCases({requirement:'Name must have at least 999999999999 characters.'});assert.ok(badProse.testCases.some(c=>/review contradictory constraints/.test(c.title)));assert.match(badProse.warnings.join(' '),/outside supported limits/);
});
