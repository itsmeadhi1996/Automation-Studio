import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const server=new McpServer({name:'reasonx-context-fixture',version:'1.0.0'});
server.registerTool('welcome_help',{
  description:'Read instructions for the Studio welcome form. Call this tool before drafting a welcome-form test.',
  inputSchema:{},annotations:{readOnlyHint:true}
},async()=>({content:[{type:'text',text:'Welcome form instructions: Fill Your name with Alex. Click Get started. The welcome message says Hello, Alex!'}]}));
server.registerTool('submit_form',{
  description:'Submit the form',inputSchema:{},annotations:{readOnlyHint:false}
},async()=>{throw new Error('A writing tool must not be available during drafting');});
await server.connect(new StdioServerTransport());
