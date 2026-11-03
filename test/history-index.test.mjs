import test from 'node:test';
import assert from 'node:assert/strict';
import {indexQaHistory, sortRunsNewestFirst} from '../public/run-history.js';
import {queryRunHistory} from '../history-query.mjs';

test('QA history preserves dataset status precedence, canonical IDs and project isolation', () => {
  const statuses=['passed','failed','blocked','running','pending','interrupted','skipped'];
  for(const runStatus of ['running','passed','failed','interrupted']){
    for(const first of statuses)for(const second of statuses){
      const run={id:'latest',projectId:'p',startedAt:'2026-10-17',status:runStatus,tests:[
        {id:'row-1',sourceTestId:'automation',qaCaseId:'qa',status:first},
        {id:'row-2',sourceTestId:'automation',qaCaseId:'qa',status:second},
        {id:'legacy-row',sourceTestId:'legacy',status:'passed'},
        {id:'manual',status:'blocked'}
      ]};
      const older={...run,id:'older',startedAt:'2026-10-16',tests:[{id:'qa',status:'failed'},{id:'old-only',status:'passed'}]};
      const foreign={...run,id:'foreign',projectId:'other',startedAt:'2026-10-18',tests:[{id:'qa',status:'failed'}]};
      const index=indexQaHistory([older,foreign,run],'p');
      const expected=[first,second].includes('failed')?'failed'
        :[first,second].includes('blocked')?'blocked'
        :[first,second].some(value=>['running','pending'].includes(value))?(runStatus==='running'?'running':'interrupted')
        :first==='passed'&&second==='passed'?'passed':first;
      assert.equal(index.latest.get('qa').status,expected);
      assert.equal(index.latest.get('qa').run,run);
      assert.equal(index.latest.get('legacy').status,'passed');
      assert.equal(index.latest.get('manual').status,'blocked');
      assert.equal(index.latest.get('old-only').run,older);
      assert.equal(index.latest.has('automation'),false);
      assert.equal(index.latest.has('missing'),false);
      assert.deepEqual(index.runs,[run,older]);
    }
  }
});

test('history sorting reads timestamps once and preserves caller ordering for QA ties', () => {
  let reads=0;
  const source=Array.from({length:300},(_,i)=>({id:String(i),get startedAt(){reads++;return new Date(Date.UTC(2026,0,1+(i*17)%31)).toISOString();}}));
  const before=[...source];
  const sorted=sortRunsNewestFirst(source);
  assert.equal(reads,source.length);
  assert.deepEqual(source,before);
  assert.deepEqual(sorted,[...source].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||a.id.localeCompare(b.id)));
  const ties=[{id:'z',startedAt:'2026-10-17'},{id:'a',startedAt:'2026-10-17'}];
  assert.deepEqual(sortRunsNewestFirst(ties,false),ties);
  assert.deepEqual(sortRunsNewestFirst(ties),[ties[1],ties[0]]);
});

test('history filter options include unmatched runs and dates remain inclusive', () => {
  const source=[
    {id:'z',startedAt:'2026-10-17',status:'passed',suiteName:'Smoke',tests:[{name:'Login'}]},
    {id:'a',startedAt:'2026-10-17',status:'passed',suiteName:'Smoke',tests:[{name:'Login'}]},
    {id:'b',startedAt:'invalid',status:'failed',suiteName:'Other',tests:[{name:'Checkout'}]}
  ];
  const result=queryRunHistory(source,new URLSearchParams({testName:'LOGIN',suiteName:'SMO',from:'2026-10-17',to:'2026-10-17',limit:'1',offset:'999'}));
  assert.equal(result.total,2);assert.equal(result.offset,1);assert.equal(result.runs[0].id,'z');
  assert.deepEqual(result.filters,{testNames:['Checkout','Login'],suiteNames:['Other','Smoke'],statuses:['failed','passed']});
  assert.equal(queryRunHistory(source,new URLSearchParams({from:'2026-10-17'})).total,2);
  assert.equal(queryRunHistory([],new URLSearchParams()).total,0);
});
