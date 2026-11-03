import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverTestPlans} from '../public/run-history.js';

test('recovery preserves project order for conflicting historical aliases and owners',()=>{
  const project={id:'p',tests:[
    {id:'first',automation:{id:'shared'},qa:{owner:'Sam'}},
    {id:'second',qaCaseId:'canonical',automation:{id:'shared'},qa:{owner:'Lee'}},
    {id:'duplicate',qaCaseId:'canonical',qa:{owner:'Pat'}}
  ]};
  const runs=[
    {id:'one',projectId:'p',startedAt:'2026-01-02',tests:[{qaCaseId:'canonical',sourceTestId:'shared'}]},
    {id:'two',projectId:'p',startedAt:'2026-01-01',tests:[{id:'second'}]}
  ];
  const before=structuredClone({project,runs});
  const plans=recoverTestPlans(project,runs).testPlans;
  assert.deepEqual(plans.map(p=>p.testIds),[['first'],['canonical']]);
  assert.deepEqual(plans.map(p=>p.assignedTo),['Sam','']);
  assert.deepEqual({project,runs},before);
  assert.equal(recoverTestPlans({...project,testPlans:[]},runs).testPlans.length,0);
});

test('recovery indexes project identities instead of rescanning them for every snapshot',()=>{
  let identityReads=0;
  const tests=Array.from({length:2000},(_,index)=>({
    get id(){identityReads++;return 'case-'+index;},qa:{owner:'Sam'}
  }));
  const runs=Array.from({length:50},(_,index)=>({id:'run-'+index,projectId:'p',
    startedAt:'2026-01-01',tests:[{id:'case-1999'}]}));
  const plans=recoverTestPlans({id:'p',tests},runs).testPlans;
  assert.equal(plans.length,1);
  assert.deepEqual(plans[0].testIds,['case-1999']);
  assert.equal(plans[0].assignedTo,'Sam');
  assert.ok(identityReads<tests.length*4,`Unexpected repeated scans: ${identityReads}`);
});
