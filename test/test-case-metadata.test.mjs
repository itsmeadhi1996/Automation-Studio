import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTestCases, validateGenerationInput, metadataFromInspection, generationOutputSchema } from '../test-case-generator.mjs';
import { requirementFields } from '../requirements.mjs';

const pageMetadata={fields:[{name:'Email',type:'email',constraints:{required:true}}],controls:[{name:'Submit',type:'submit'}]};
const requirement='Email is required.';

test('optional empty metadata and nullable collections do not block generation',()=>{
  const baseline=generateTestCases({requirement});
  for(const value of [null,'','   ',[],{},'{}','null',{fields:null,controls:null,constraints:null}]){
    const result=generateTestCases({requirement,pageMetadata:value});assert.deepEqual(result,baseline);
  }
});

test('JSON metadata and nested tool-call metadata normalize to the same scenarios',()=>{
  const baseline=generateTestCases({requirement,pageMetadata});
  for(const value of [JSON.stringify(pageMetadata),JSON.stringify(JSON.stringify(pageMetadata)),{pageMetadata},{name:'generate_test_cases',pageMetadata:JSON.stringify(pageMetadata)}])assert.deepEqual(generateTestCases({requirement,pageMetadata:value}),baseline);
  const saved=requirementFields({title:'Example',url:'https://example.test',description:requirement,pageMetadata:JSON.stringify(pageMetadata)});assert.deepEqual(saved.pageMetadata,pageMetadata);
});

test('page annotations cannot cause root schema errors or persist unrelated secret values',()=>{
  const value={...pageMetadata,title:'Example page',url:'https://example.test',apiKey:'sensitive-example-do-not-return',unknownBusinessRule:'needs-explicit-schema'};
  const normalized=validateGenerationInput({requirement,pageMetadata:value});assert.deepEqual(normalized.pageMetadata,pageMetadata);
  const result=generateTestCases({requirement,pageMetadata:value});assert.match(result.warnings.join(' '),/Additional page annotations were ignored/);assert.doesNotMatch(JSON.stringify(result),/sensitive-example-do-not-return/);
  assert.deepEqual(result.testCases,generateTestCases({requirement,pageMetadata}).testCases);
  const saved=requirementFields({title:'Example',url:'https://example.test',description:requirement,pageMetadata:value});assert.deepEqual(saved.pageMetadata,pageMetadata);assert.match(saved.metadataWarnings.join(' '),/annotations/);assert.doesNotMatch(JSON.stringify(saved),/sensitive-example-do-not-return/);
  assert.deepEqual(requirementFields(saved).metadataWarnings,saved.metadataWarnings);
});

test('malformed metadata gives a precise field and reason without submitted values',()=>{
  const cases=[
    ['invalid-secret-text',/pageMetadata must be a JSON object/],
    [42,/pageMetadata must be a JSON object/],
    [[{name:'Email'}],/pageMetadata must be a JSON object/],
    [{fields:'invalid-secret-text'},/pageMetadata\.fields must be an array/],
    [{fields:[{name:'Age',constraints:{min:'invalid-secret-text'}}]},/pageMetadata\.fields\.0\.constraints\.min must be a number/],
    [{fields:[{name:'Age',constraints:{min:20,max:10}}]},/min must not exceed max/],
    [{controls:[{name:'Save',type:'invalid-secret-text'}]},/pageMetadata\.controls\.0\.type must use a supported/]
  ];
  for(const [value,pattern] of cases)assert.throws(()=>generateTestCases({requirement,pageMetadata:value}),error=>pattern.test(error.message)&&!error.message.includes('invalid-secret-text'));
});

test('legacy supplied metadata and invalid observed attributes cannot poison inspection generation',()=>{
  const inspection={pages:[{controls:[{tag:'input',label:'Age',type:'number',min:'30',max:'20',step:'any'},{tag:'input',label:'Name',type:'text',minLength:'0.5',maxLength:'9999999999',step:'not-a-number'},{tag:'input',label:'   ',type:'text'}]}]};
  const metadata=metadataFromInspection(inspection,JSON.stringify({...pageMetadata,title:'Registration'}));
  assert.equal(metadata.pageMetadata.fields.length,4);assert.match(metadata.warnings.join(' '),/Unsupported inspected field attributes/);assert.match(metadata.warnings.join(' '),/page annotations/);
  const result=generateTestCases({requirement,pageMetadata:metadata.pageMetadata});assert.ok(generationOutputSchema.safeParse(result).success);
  assert.ok(result.testCases.some(c=>c.title==='Age: review contradictory constraints'));assert.ok(result.testCases.some(c=>c.title==='Email: required value is missing'));
});
