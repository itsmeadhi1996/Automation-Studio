import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudio } from './support.mjs';

async function fixture(t,port){
  const options={port,storage:path.resolve('.test-output',`requirement-approval-${port}-${Date.now()}`)};
  let studio=await createStudio(options);await studio.listen();t.after(()=>studio.close());
  const base=`http://127.0.0.1:${port}`;
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const initial=studio.store.projects[0],root=`/api/projects/${initial.id}/requirements`;
  const created=await api(root,'POST',{revision:initial.revision,title:'Registration',url:'https://example.test/register',description:'Email is required. Email must be a valid email address.',categories:['Positive','Validation','Negative']});assert.equal(created.status,201);
  const route=root+'/'+created.data.requirement.id;
  const counterBefore=studio.store.nextTestNumber,generated=await api(route+'/generate','POST',{revision:created.data.project.revision});assert.equal(generated.status,201);
  return {api,route,initial,counterBefore,generated:generated.data,get studio(){return studio;},restart:async()=>{await studio.close();studio=await createStudio(options);await studio.listen();}};
}

test('generation stays in requirements until selected drafts are approved, with durable numbers and no duplicate approval',async t=>{
  const f=await fixture(t,3530),count=f.initial.tests.length,counter=f.counterBefore;assert.equal(f.studio.store.nextTestNumber,counter);
  let {project,requirement}=f.generated;const drafts=requirement.draftCases;
  assert.ok(drafts.length>=3);assert.equal(project.tests.length,count);assert.deepEqual(requirement.testIds,[]);assert.ok(drafts.every(item=>item.tcNumber===undefined));
  const automation=(await f.api('/api/state?workspace=automation')).data.projects.find(item=>item.id===project.id);assert.ok(automation.tests.every(item=>!drafts.some(draft=>draft.id===item.id)));
  assert.equal((await f.api('/api/manual-runs','POST',{projectId:project.id,testId:drafts[0].id})).status,400);
  await f.restart();let saved=(await f.api(f.route)).data;assert.equal(saved.draftCases.length,drafts.length);assert.equal(f.studio.store.nextTestNumber,counter);
  const approval=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[drafts[0].id]});assert.equal(approval.status,200);assert.equal(approval.data.approvedCount,1);
  project=approval.data.project;requirement=approval.data.requirement;assert.equal(project.tests.length,count+1);assert.equal(requirement.draftCases.length,drafts.length-1);assert.deepEqual(requirement.testIds,[drafts[0].id]);
  const approved=project.tests.find(item=>item.id===drafts[0].id);assert.equal(approved.tcNumber,counter);assert.equal(approved.inTestPlan,false);assert.deepEqual(approved.qa.testData,drafts[0].qa.testData);assert.equal(f.studio.store.nextTestNumber,counter+1);
  const again=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[drafts[0].id]});assert.equal(again.status,200);assert.equal(again.data.approvedCount,0);assert.equal(again.data.project.tests.length,count+1);assert.equal(f.studio.store.nextTestNumber,counter+1);
  await f.restart();saved=(await f.api(f.route)).data;assert.deepEqual(saved.testIds,[approved.id]);assert.equal(saved.draftCases.length,drafts.length-1);assert.equal(f.studio.store.nextTestNumber,counter+1);
});

test('draft edits survive regeneration and approvals are atomic and revision checked',async t=>{
  const f=await fixture(t,3531);let {project,requirement}=f.generated;const draft=requirement.draftCases[0],counter=f.studio.store.nextTestNumber;
  const invalid=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[draft.id,randomUUID()]});assert.equal(invalid.status,400);assert.match(invalid.data.userMessage,/no longer available/);assert.equal(f.studio.store.nextTestNumber,counter);assert.equal(f.studio.store.projects[0].tests.length,project.tests.length);
  const edit=await f.api(f.route+'/drafts/'+draft.id,'PUT',{revision:project.revision,...draft,name:'Reviewed registration draft',qa:{...draft.qa,manualSteps:[{...draft.qa.manualSteps[0],instruction:'Reviewed instruction'}]}});assert.equal(edit.status,200);project=edit.data.project;
  const stale=await f.api(f.route+'/approve','POST',{revision:f.generated.project.revision,draftIds:[draft.id]});assert.equal(stale.status,409);
  const repeated=await f.api(f.route+'/generate','POST',{revision:project.revision});assert.equal(repeated.status,201);assert.equal(repeated.data.addedCount,0);project=repeated.data.project;
  const kept=repeated.data.requirement.draftCases.find(item=>item.id===draft.id);assert.equal(kept.name,'Reviewed registration draft');assert.equal(kept.qa.manualSteps[0].instruction,'Reviewed instruction');assert.equal(project.tests.length,f.initial.tests.length);
  const approved=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[draft.id]});assert.equal(approved.status,200);const testCase=approved.data.project.tests.find(item=>item.id===draft.id);assert.equal(testCase.name,kept.name);assert.equal(testCase.qa.manualSteps[0].instruction,'Reviewed instruction');
});

test('approval validates reviewed edits and commits the edited steps and approval together',async t=>{
  const f=await fixture(t,3534),{project,requirement}=f.generated,[first,second]=requirement.draftCases,counter=f.studio.store.nextTestNumber;
  const edited={...first,name:'Reviewed email registration',qa:{...first.qa,generationId:'TCG-'+'a'.repeat(24),workflowDetails:'Open registration. Enter the email. Click Register.',expectedResult:'The account is registered.',manualSteps:[{id:randomUUID(),instruction:'Open the registration page.',expectedResult:'The registration form appears.'},{id:randomUUID(),instruction:'Enter a valid test email and click Register.',expectedResult:'The account is registered.'}]}};
  const approve=editedDrafts=>f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[first.id,second.id],editedDrafts});
  for(const edits of [null,{},[{...edited,id:randomUUID()}],[edited,edited],[{...edited,qa:'invalid'}],[edited,{...second,name:''}],[edited,{...second,qa:{...second.qa,manualSteps:[]}}]]){
    const response=await approve(edits);assert.equal(response.status,400,JSON.stringify(response.data));assert.ok(response.data.userMessage);assert.equal(f.studio.store.projects[0].revision,project.revision);assert.equal(f.studio.store.nextTestNumber,counter);assert.deepEqual((await f.api(f.route)).data,requirement);
  }
  const accepted=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[first.id],editedDrafts:[edited]});assert.equal(accepted.status,200,JSON.stringify(accepted.data));assert.equal(accepted.data.approvedCount,1);assert.equal(accepted.data.project.revision,project.revision+1);
  const testCase=accepted.data.project.tests.find(item=>item.id===first.id);assert.equal(testCase.name,edited.name);assert.deepEqual(testCase.qa.manualSteps,edited.qa.manualSteps);assert.equal(testCase.qa.expectedResult,edited.qa.expectedResult);assert.equal(testCase.qa.workflowDetails,edited.qa.workflowDetails);assert.equal(testCase.qa.generationId,first.qa.generationId);assert.equal(testCase.inTestPlan,false);assert.equal(f.studio.store.nextTestNumber,counter+1);
  assert.ok(accepted.data.requirement.draftCases.some(item=>item.id===second.id));assert.deepEqual(accepted.data.requirement.testIds,[first.id]);
  const stale=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[second.id],editedDrafts:[{...second,name:'Stale review'}]});assert.equal(stale.status,409);assert.equal(f.studio.store.projects[0].revision,accepted.data.project.revision);assert.equal((await f.api(f.route)).data.draftCases.find(item=>item.id===second.id).name,second.name);
  await f.restart();assert.deepEqual(f.studio.store.projects[0].tests.find(item=>item.id===first.id).qa.manualSteps,edited.qa.manualSteps);
});

test('pending drafts can be deleted one at a time or in bulk, and approved cases are protected',async t=>{
  const f=await fixture(t,3548);let {project,requirement}=f.generated;const [first,second,third]=requirement.draftCases,total=requirement.draftCases.length;
  const single=await f.api(f.route+'/drafts/'+first.id,'DELETE',{revision:project.revision});assert.equal(single.status,200);assert.equal(single.data.requirement.draftCases.length,total-1);project=single.data.project;
  const empty=await f.api(f.route+'/drafts','DELETE',{revision:project.revision,draftIds:[]});assert.equal(empty.status,400);
  const unknown=await f.api(f.route+'/drafts','DELETE',{revision:project.revision,draftIds:[second.id,randomUUID()]});assert.equal(unknown.status,404);assert.equal((await f.api(f.route)).data.draftCases.length,total-1);
  const stale=await f.api(f.route+'/drafts','DELETE',{revision:f.generated.project.revision,draftIds:[second.id]});assert.equal(stale.status,409);
  const bulk=await f.api(f.route+'/drafts','DELETE',{revision:project.revision,draftIds:[second.id,third.id]});assert.equal(bulk.status,200);assert.equal(bulk.data.deletedCount,2);assert.equal(bulk.data.requirement.draftCases.length,total-3);project=bulk.data.project;
  const regenerated=await f.api(f.route+'/generate','POST',{revision:project.revision});assert.equal(regenerated.status,201);project=regenerated.data.project;
  const remaining=regenerated.data.requirement.draftCases[0];const approval=await f.api(f.route+'/approve','POST',{revision:project.revision,draftIds:[remaining.id]});assert.equal(approval.status,200);
  const approvedDelete=await f.api(f.route+'/drafts/'+remaining.id,'DELETE',{revision:approval.data.project.revision});assert.equal(approvedDelete.status,404);assert.ok(approval.data.project.tests.some(item=>item.id===remaining.id));
});
