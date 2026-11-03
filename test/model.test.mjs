import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, prepareRun, resolveTarget, resolveValue, sampleProject } from '../model.mjs';
test('TC numbers survive rename, membership changes, deletions, and attempted client overrides', () => {
  const store={nextTestNumber:1}; let p=normalizeProject(sampleProject(3100),null,store);
  assert.equal(p.tests[0].tcNumber,1);
  const input=structuredClone(p);input.tests[0].name='Renamed';input.tests[0].suiteId=null;input.tests[0].tcNumber=999;
  p=normalizeProject(input,p,store);assert.equal(p.tests[0].tcNumber,1);assert.equal(p.tests[0].suiteId,null);
  const empty=normalizeProject({...p,tests:[]},p,store);
  const fresh=normalizeProject({...empty,tests:[{id:'new',name:'New test',steps:[]}]},empty,store);
  assert.equal(fresh.tests[0].tcNumber,2);
  const second=normalizeProject(sampleProject(3100),null,store);assert.equal(second.tests[0].tcNumber,3);
});
test('invalid membership and duplicate IDs cannot consume TC numbers', () => {
  const store={nextTestNumber:1};const raw=sampleProject(3100);raw.tests.push({...raw.tests[0]});
  assert.throws(()=>normalizeProject(raw,null,store),/Duplicate test ID/);assert.equal(store.nextTestNumber,1);
  raw.tests.pop();raw.tests[0].suiteId='missing';assert.throws(()=>normalizeProject(raw,null,store),/Unknown suites/);
});
test('prerequisites and execution context are immutable snapshots',()=>{
  const store={nextTestNumber:1},raw=sampleProject(3100);raw.prerequisites=[{id:'setup',name:'Setup',steps:[{action:'wait',value:'0'}]}];raw.tests[0].prerequisiteId='setup';raw.tests[0].inTestPlan=true;
  const p=normalizeProject(raw,null,store),run=prepareRun(p,{suiteId:'smoke'});
  assert.equal(run.tests[0].steps[0].phase,'prerequisite');p.prerequisites[0].steps[0].value='50';p.environments[0].variables.BASE_URL='changed';
  assert.equal(run.tests[0].steps[0].value,'0');assert.match(run.context.environment.BASE_URL,/demo$/);
  assert.throws(()=>prepareRun(p,{suiteId:'unknown'}),/Unknown suite/);
  p.tests[0].suiteId=null;assert.throws(()=>prepareRun(p,{suiteId:'smoke'}),/No tests/);
});
test('repository substitutions are literal, global, legacy compatible, and non-mutating',()=>{
  const objects=[{id:'button',xpath:'//button[@id="XXX" or @name="{{value}}"]'}];
  assert.equal(resolveTarget({locatorType:'object',target:'button',replacement:'$&'},objects),'//button[@id="$&" or @name="$&"]');
  assert.match(objects[0].xpath,/XXX/);
  assert.throws(()=>resolveTarget({locatorType:'object',target:'missing'},objects),/not found/);
  assert.throws(()=>resolveTarget({locatorType:'object',target:'plain',replacement:'x'},[{id:'plain',xpath:'//button'}]),/no replacement/);
});
test('variables use own keys only and fail for missing inputs',()=>{
  const context={globals:{NAME:'Alex'},environment:{NAME:'Sam'}};
  assert.equal(resolveValue({valueMode:'global',value:'NAME'},context),'Alex');
  assert.equal(resolveValue({valueMode:'environment',value:'NAME'},context),'Sam');
  assert.throws(()=>resolveValue({valueMode:'global',value:'toString'},context),/not found/);
});
