import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateTestCases, generationOutputSchema } from '../test-case-generator.mjs';

test('real stdio server advertises schemas, returns structured cases, rejects invalid calls and needs no backend or credentials',{timeout:20000},async t=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('test-case-mcp.mjs')],env:{STUDIO_URL:'http://127.0.0.1:1',STUDIO_USERNAME:'ignored-user',STUDIO_PASSWORD:'do-not-log-this-password',OPENAI_API_KEY:'do-not-log-this-key'},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>stderr+=data.toString());
  const client=new Client({name:'test-case-test-client',version:'1.0.0'});t.after(()=>client.close());await client.connect(transport);
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),['generate_test_cases']);
  const tool=tools[0];assert.ok(tool.inputSchema.required.includes('requirement'));assert.ok(tool.outputSchema.properties.testCases);assert.equal(tool.annotations.openWorldHint,false);assert.equal(tool.annotations.readOnlyHint,true);
  const input={requirement:'Email is required.',moduleName:'Registration',pageMetadata:{fields:[{name:'Email',type:'email',constraints:{required:true}}]},categories:['Validation','Negative']};
  const result=await client.callTool({name:'generate_test_cases',arguments:input});assert.ok(!result.isError);assert.deepEqual(result.structuredContent,generateTestCases(input));assert.ok(generationOutputSchema.safeParse(result.structuredContent).success);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  assert.deepEqual((await client.callTool({name:'generate_test_cases',arguments:input})).structuredContent,result.structuredContent);
  for(const args of [{},{requirement:' '},{requirement:'Register',categories:['Unknown']},{requirement:'Register',pageMetadata:{fields:'bad'}}])assert.equal((await client.callTool({name:'generate_test_cases',arguments:args})).isError,true);
  const conflict=await client.callTool({name:'generate_test_cases',arguments:{requirement:'Email is required.',pageMetadata:{fields:[{name:'Email',constraints:{required:false}}]}}});assert.ok(!conflict.isError);assert.match(conflict.structuredContent.warnings.join(' '),/required follows requirement description/);assert.ok(conflict.structuredContent.testCases.some(c=>c.title==='Email: required value is missing'));
  for(const pageMetadata of [null,'{}',{fields:null},{title:'Example page',fields:[{name:'Email',type:'email'}]}]){
    const normalized=await client.callTool({name:'generate_test_cases',arguments:{requirement:input.requirement,pageMetadata}});assert.ok(!normalized.isError,JSON.stringify(normalized.content));assert.ok(generationOutputSchema.safeParse(normalized.structuredContent).success);
  }
  assert.ok(!(await client.callTool({name:'generate_test_cases',arguments:input})).isError);await client.close();assert.equal(stderr,'');
});
