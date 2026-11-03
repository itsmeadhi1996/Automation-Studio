import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTestCases } from '../test-case-generator.mjs';
import { requirementErrorUserMessage } from '../requirement-errors.mjs';

test('generation validation supplies plain instructions without technical paths or submitted values',()=>{
  const examples=[
    [{requirement:''},/Enter a description/],
    [{requirement:'Register',categories:[]},/Select at least one test category/],
    [{requirement:'Register',pageMetadata:'private-value'},/optional page details could not be read/],
    [{requirement:'Register',pageMetadata:{fields:'private-value'}},/list of page fields could not be read/],
    [{requirement:'Register',pageMetadata:{fields:[{name:'Age',constraints:{min:'private-value'}}]}},/Enter a number for the smallest allowed value for page field 1/],
    [{requirement:'Register',pageMetadata:{fields:[{name:'Age',constraints:{min:20,max:10}}]}},/smallest allowed value is higher than the largest for page field 1/],
    [{requirement:'Register',pageMetadata:{fields:[{name:'Name',constraints:{minLength:20,maxLength:10}}]}},/minimum text length is higher than the maximum/]
  ];
  for(const [input,expected] of examples)assert.throws(()=>generateTestCases(input),error=>{
    assert.match(error.userMessage,expected);assert.doesNotMatch(error.userMessage,/pageMetadata|\.fields\.|JSON|schema|private-value/);assert.ok(error.code==='INVALID_GENERATION_INPUT');
    assert.equal(requirementErrorUserMessage(error),error.userMessage);return true;
  });
});

test('requirement failures explain the next action and keep raw service details out of the message',()=>{
  const examples=[
    [new Error('Configure an AI model and API key'),/Choose Local rules/],
    [new Error('Could not inspect the requirement URL. private-value'),/Check that the URL opens in your browser/],
    [Object.assign(new Error('Conflict'),{code:'EDIT_CONFLICT'}),/Copy any unsaved text, refresh the page/],
    [new Error('Generation is already running'),/Wait for that to finish/],
    [new Error('Test case generation failed: private-value'),/ask your administrator to check the AI settings/],
    [new Error('TypeError: private-value in C:/workspace/service.mjs'),/ask your administrator for help/],
    [Object.assign(new Error('private-value'),{status:403}),/Ask your administrator for access/],
    [Object.assign(new Error('private-value'),{status:401}),/Sign in again/]
  ];
  for(const [error,expected] of examples){const message=requirementErrorUserMessage(error);assert.match(message,expected);assert.doesNotMatch(message,/private-value|TypeError|workspace|\.mjs/);}
});
