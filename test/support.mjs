import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createStudio as createRealStudio } from '../server.mjs';

// Only disposable test workspaces can opt into a portable test key when the
// sandbox Windows account lacks a loaded DPAPI profile. Production is unchanged.
export async function createStudio(options) {
  if (process.env.QA_TEST_PORTABLE_VAULT === '1') {
    const root = path.resolve('.test-output');
    const storage = path.resolve(options.storage || '');
    if (!storage.startsWith(root + path.sep)) throw new Error('Portable test vault must stay under .test-output');
    const data = path.join(storage, 'data');
    await mkdir(data, {recursive:true});
    try { await writeFile(path.join(data,'credentials.key'), JSON.stringify({key:randomBytes(32).toString('base64')}), {flag:'wx',mode:0o600}); }
    catch(error) { if(error.code !== 'EEXIST') throw error; }
  }
  const studio = await createRealStudio(options);
  if (options.authenticated === false) return studio;
  // Existing engine/browser regressions run as an authenticated administrator.
  // This adapter exists only in tests; production has no authentication bypass.
  const listen = studio.listen;
  studio.listen = async () => {
    await listen();
    const base='http://127.0.0.1:'+studio.server.address().port;
    const account={username:'test-admin',name:'Test administrator',password:'Disposable-test-password-2026'};
    const session=await (await fetch(base+'/api/auth/session')).json();
    if(session.setupRequired) {
      const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)});
      if(!setup.ok)throw new Error('Test administrator setup failed');
    }
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)});
    if(!login.ok)throw new Error('Test administrator sign-in failed');
    const cookie=login.headers.get('set-cookie').split(';')[0];
    studio.server.prependListener('request',req=>{
      if(!req.headers.cookie&&!req.headers.authorization)req.headers.cookie=cookie;
    });
  };
  return studio;
}
