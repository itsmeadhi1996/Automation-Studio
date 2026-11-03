import path from 'node:path';
import { createStudio } from './support.mjs';
const studio = await createStudio({authenticated:false,port:3301,storage:path.resolve('.test-output','preview')});
await studio.listen();
console.log('QA Studio isolated preview: http://127.0.0.1:3301');
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await studio.close();process.exit();});
