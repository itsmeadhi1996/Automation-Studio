import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceVersion } from '../runtime-version.mjs';
import { restartStudio, resolveStudioStorage, studioStopper } from '../studio-restart.mjs';
import { createStudio } from './support.mjs';

const exec = promisify(execFile);
const root = path.resolve('.');
const json = (data,status=200) => Response.json(data,{status});
const idle = {activeRun:null,activeRecording:null,activeDebug:null};

test('restart selects the live workspace and refuses unknown or ambiguous process locks',async()=>{
  const directory=path.resolve('.test-output','restart-storage-'+Date.now());
  const working=path.join(directory,'.test-output','working-workspace');
  await mkdir(path.join(directory,'data'),{recursive:true});
  await mkdir(path.join(working,'data'),{recursive:true});
  await writeFile(path.join(directory,'data','studio.lock'),JSON.stringify({pid:111}));
  await writeFile(path.join(working,'data','studio.lock'),JSON.stringify({pid:222}));
  assert.equal(await resolveStudioStorage(directory,{pid:222}),working);
  assert.equal(await resolveStudioStorage(directory,{pid:111}),directory);
  assert.equal(await resolveStudioStorage(directory),directory);
  assert.equal(await resolveStudioStorage(directory,{pid:222,storage:directory}),directory);
  await assert.rejects(resolveStudioStorage(directory,{pid:333}),/Cannot identify/);
  await writeFile(path.join(directory,'data','studio.lock'),JSON.stringify({pid:222}));
  await assert.rejects(resolveStudioStorage(directory,{pid:222}),/Cannot identify/);
});

test('runtime version tracks application changes and excludes workspace data',async()=>{
  const directory=path.resolve('.test-output','runtime-version-'+Date.now());
  await mkdir(path.join(directory,'public'),{recursive:true});
  await mkdir(path.join(directory,'data'),{recursive:true});
  await writeFile(path.join(directory,'server.mjs'),'export const version = 1;');
  await writeFile(path.join(directory,'public','app.js'),'console.log("first");');
  const first=await sourceVersion(directory);
  await writeFile(path.join(directory,'data','studio.json'),'{"projects":[]}');
  assert.equal(await sourceVersion(directory),first);
  await writeFile(path.join(directory,'public','app.js'),'console.log("second");');
  const second=await sourceVersion(directory);assert.notEqual(second,first);
  await writeFile(path.join(directory,'server.mjs'),'export const version = 2;');
  assert.notEqual(await sourceVersion(directory),second);
});

test('upgrade detects an outdated authenticated server and preserves it until administrator sign-in',async t=>{
  let current=false,statusCalls=0,backupCalls=0;
  const version=await sourceVersion();
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/session'){
      res.end(JSON.stringify({setupRequired:false,user:null,...(current?{runtime:{sourceVersion:version}}:{})}));return;
    }
    if(req.url==='/api/status')statusCalls++;
    if(req.url==='/api/backups')backupCalls++;
    res.writeHead(401).end(JSON.stringify({error:'Please sign in to continue.'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const environment={...process.env,PORT:String(server.address().port)};
  for(const key of ['STUDIO_USERNAME','STUDIO_PASSWORD','STUDIO_SESSION_TOKEN'])delete environment[key];
  const launch=()=>exec(process.execPath,['launch.mjs','--upgrade'],{cwd:root,env:environment,windowsHide:true,timeout:10000});
  await assert.rejects(launch(),error=>{
    assert.equal(error.code,3);
    assert.match(error.stdout,/Restart required/);
    assert.match(error.stderr,/administrator account/);
    assert.match(error.stderr,/Restart QA Studio.cmd/);
    return true;
  });
  assert.equal(statusCalls,1);assert.equal(backupCalls,0);
  current=true;
  const fresh=await launch();
  assert.match(fresh.stdout,/QA Studio is ready/);
  assert.equal(statusCalls,1,'Opening the current server does not restart it');
});

test('restart checks activity, unlocks and backs up before stopping the locked process',async()=>{
  const directory=path.resolve('.test-output','restart-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  const events=[];
  await restartStudio({
    url:'http://127.0.0.1:1',directory,headers:{},
    request:async url=>{events.push(url.endsWith('/api/status')?'status':'backup');return json(url.endsWith('/api/status')?idle:{name:'backup-test.json'});},
    unlock:async()=>events.push('unlock'),
    kill:(pid,signal)=>{assert.equal(pid,424242);if(signal===0)throw Object.assign(new Error('Stopped'),{code:'ESRCH'});events.push('stop');},
    wait:async()=>{}
  });
  assert.deepEqual(events,['status','unlock','backup','status','stop']);
});

test('restart leaves the process running if authentication, vault, backup or final activity checks fail',async t=>{
  const directory=path.resolve('.test-output','restart-guards-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  for(const failure of ['authentication','busy','vault','backup','recheck','new activity']){
    await t.test(failure,async()=>{
      let statusCalls=0,stopped=false;
      await assert.rejects(restartStudio({
        url:'http://127.0.0.1:1',directory,headers:{},
        request:async url=>{
          if(url.endsWith('/api/status')){
            statusCalls++;
            if(failure==='authentication'||failure==='recheck'&&statusCalls===2)return json({error:'Signed out'},401);
            return json({...idle,...(failure==='busy'||failure==='new activity'&&statusCalls===2?{activeRun:'running'}:{})});
          }
          return json(failure==='backup'?{error:'Backup failed'}:{name:'backup-test.json'},failure==='backup'?500:201);
        },
        unlock:async()=>{if(failure==='vault')throw new Error('Cannot unlock workspace credentials for this Windows user');},
        kill:()=>{stopped=true;},wait:async()=>{}
      }));
      assert.equal(stopped,false);
    });
  }
});

test('restart flushes a stopped recording with the authenticated server before backing up',async()=>{
  const directory=path.resolve('.test-output','restart-draft-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  const draft={id:'saved-draft_1',status:'stopped',saving:false,saveError:null};
  const headers={Cookie:'studio=administrator-session'},events=[];
  let finishFlush;
  const flushed=new Promise(resolve=>{finishFlush=resolve;});
  const restarting=restartStudio({
    url:'http://127.0.0.1:1',directory,headers,
    request:async(url,options)=>{
      assert.equal(options.headers.Cookie,headers.Cookie);
      if(url.endsWith('/api/status')){events.push('status');return json({...idle,activeRecording:draft});}
      assert.equal(options.method,'POST');
      assert.equal(options.headers['Content-Type'],'application/json');
      assert.deepEqual(JSON.parse(options.body),{});
      if(url.endsWith('/api/recordings/'+draft.id+'/stop')){
        events.push('flush');await flushed;events.push('flushed');return json(draft);
      }
      assert.ok(url.endsWith('/api/backups'));events.push('backup');return json({name:'backup-draft.json'});
    },
    unlock:async()=>events.push('unlock'),
    kill:(pid,signal)=>{assert.equal(pid,424242);if(signal===0)throw Object.assign(new Error('Stopped'),{code:'ESRCH'});events.push('stop');},
    wait:async()=>{}
  });
  try{
    for(let i=0;i<100&&!events.includes('flush');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(events,['status','unlock','flush'],'Restart must await the recorder flush before backing up or stopping');
  }finally{finishFlush();await restarting;}
  assert.deepEqual(events,['status','unlock','flush','flushed','backup','status','stop']);
});

test('restart rejects unfinished recordings and debug sessions at both activity checks',async t=>{
  const directory=path.resolve('.test-output','restart-session-guards-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  const cases=[
    ['recording',{activeRecording:{id:'draft',status:'recording'}},/active|busy|finish/i],
    ['paused',{activeRecording:{id:'draft',status:'paused'}},/active|busy|finish/i],
    ['unknown recording state',{activeRecording:{id:'draft',status:'unknown'}},/active|busy|finish/i],
    ['missing recording state',{activeRecording:{id:'draft'}},/active|busy|finish/i],
    ['saving',{activeRecording:{id:'draft',status:'stopped',saving:true}},/sav/i],
    ['save error',{activeRecording:{id:'draft',status:'stopped',saveError:'Disk is full'}},/sav/i],
    ['completed debug session',{activeDebug:{id:'debug',status:'passed'}},/active|busy|finish/i],
    ['failed debug session',{activeDebug:{id:'debug',status:'failed'}},/active|busy|finish/i]
  ];
  for(const stage of [1,2])for(const [name,activity,message] of cases){
    await t.test(name+' at check '+stage,async()=>{
      let checks=0,backups=0,flushes=0,stopped=false,unlocked=false;
      await assert.rejects(restartStudio({
        url:'http://127.0.0.1:1',directory,headers:{},
        request:async url=>{
          if(url.endsWith('/api/status'))return json({...idle,...(++checks===stage?activity:{})});
          if(url.endsWith('/api/backups')){backups++;return json({name:'backup-test.json'});}
          flushes++;throw new Error('Unsafe recording must not be flushed');
        },
        unlock:async()=>{unlocked=true;},kill:()=>{stopped=true;},wait:async()=>{}
      }),message);
      assert.equal(stopped,false);assert.equal(flushes,0);
      assert.equal(checks,stage);assert.equal(backups,stage===1?0:1);assert.equal(unlocked,stage===2);
    });
  }
});

test('F10: restart refuses while a generation is running, at both activity checks',async t=>{
  const directory=path.resolve('.test-output','restart-generation-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  for(const stage of [1,2])await t.test('check '+stage,async()=>{
    let checks=0,stopped=false;
    await assert.rejects(restartStudio({
      url:'http://127.0.0.1:1',directory,headers:{},
      request:async url=>url.endsWith('/api/status')
        ?json({...idle,activeGenerations:++checks===stage?[{id:'job',status:'running'}]:[]})
        :json({name:'backup-test.json'}),
      unlock:async()=>{},kill:()=>{stopped=true;},wait:async()=>{}
    }),/generation/i);
    assert.equal(stopped,false);assert.equal(checks,stage);
  });
});

test('F10: the default stopper asks the server to shut down on Windows and never hard-kills a server that refuses',async t=>{
  const url='http://127.0.0.1:1',headers={Cookie:'studio=administrator-session'};
  const signals=[];
  const killProcess=(pid,signal)=>{signals.push([pid,signal]);};
  const stopper=(request,platform='win32')=>studioStopper({url,headers,request,platform,killProcess});
  await t.test('graceful request',async()=>{
    signals.length=0;
    const calls=[];
    await stopper(async(target,options)=>{calls.push({target,options});return json({stopping:true},202);})(424242,'SIGTERM');
    assert.equal(calls[0].target,url+'/api/admin/shutdown');
    assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[0].options.headers.Cookie,headers.Cookie);
    assert.deepEqual(JSON.parse(calls[0].options.body),{pid:424242});
    assert.deepEqual(signals,[]);
  });
  await t.test('liveness probe stays local',async()=>{
    signals.length=0;
    await stopper(async()=>{throw new Error('No request expected');})(424242,0);
    assert.deepEqual(signals,[[424242,0]]);
  });
  await t.test('refusal and network failure leave the process running',async()=>{
    signals.length=0;
    await assert.rejects(stopper(async()=>json({error:'Studio is busy'},409))(424242,'SIGTERM'),/Studio is busy/);
    await assert.rejects(stopper(async()=>{throw new Error('Connection refused');})(424242,'SIGTERM'),/was not stopped/);
    assert.deepEqual(signals,[]);
  });
  await t.test('a server without the route falls back to the signal',async()=>{
    signals.length=0;
    await stopper(async()=>json({error:'Not found'},404))(424242,'SIGTERM');
    assert.deepEqual(signals,[[424242,'SIGTERM']]);
  });
  await t.test('other platforms use the signal',async()=>{
    signals.length=0;
    await stopper(async()=>{throw new Error('No request expected');},'linux')(424242,'SIGTERM');
    assert.deepEqual(signals,[[424242,'SIGTERM']]);
  });
});

test('F11: the default vault check refuses a missing key and never creates one',async()=>{
  const directory=path.resolve('.test-output','restart-missing-key-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  let backups=0,stopped=false;
  await assert.rejects(restartStudio({
    url:'http://127.0.0.1:1',directory,headers:{},
    request:async url=>{if(url.endsWith('/api/backups'))backups++;return json(idle);},
    kill:()=>{stopped=true;},wait:async()=>{}
  }),/credentials\.key is missing/);
  assert.equal(backups,0);assert.equal(stopped,false);
  assert.deepEqual(await readdir(directory),['studio.lock']);
});

test('restart preserves the process and skips backup when a stopped recording cannot be flushed safely',async t=>{
  const directory=path.resolve('.test-output','restart-flush-guards-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  const draft={id:'saved-draft',status:'stopped',saving:false,saveError:null};
  const cases=[
    ['HTTP failure',()=>json({error:'Cannot save'},500)],
    ['network failure',()=>{throw new Error('Connection closed');}],
    ['malformed response',()=>new Response('not json')],
    ['different recording',()=>json({...draft,id:'different-draft'})],
    ['recording resumed',()=>json({...draft,status:'recording'})],
    ['recording still saving',()=>json({...draft,saving:true})],
    ['recording save failed',()=>json({...draft,saveError:'Disk is full'})]
  ];
  for(const [name,result] of cases)await t.test(name,async()=>{
    let stopped=false,backups=0,flushes=0;
    await assert.rejects(restartStudio({
      url:'http://127.0.0.1:1',directory,headers:{},
      request:async url=>{
        if(url.endsWith('/api/status'))return json({...idle,activeRecording:draft});
        if(url.endsWith('/api/backups')){backups++;return json({name:'backup-test.json'});}
        assert.ok(url.endsWith('/api/recordings/saved-draft/stop'));flushes++;return result();
      },
      unlock:async()=>{},kill:()=>{stopped=true;},wait:async()=>{}
    }));
    assert.equal(flushes,1);assert.equal(backups,0);assert.equal(stopped,false);
  });
  for(const id of [undefined,'','../other','draft?mode=discard'])await t.test('invalid draft id '+String(id),async()=>{
    let requests=0,stopped=false;
    await assert.rejects(restartStudio({
      url:'http://127.0.0.1:1',directory,headers:{},
      request:async()=>{requests++;return json({...idle,activeRecording:{...draft,id}});},
      unlock:async()=>{},kill:()=>{stopped=true;},wait:async()=>{}
    }));
    assert.equal(requests,1);assert.equal(stopped,false);
  });
});

test('restart does not stop a newly appearing recording that has not been flushed',async t=>{
  const directory=path.resolve('.test-output','restart-new-draft-'+Date.now());
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  const draft={id:'initial-draft',status:'stopped',saving:false,saveError:null};
  for(const initial of [null,draft])await t.test(initial?'replaced draft':'new draft',async()=>{
    let statuses=0,flushes=0,backups=0,stopped=false;
    await assert.rejects(restartStudio({
      url:'http://127.0.0.1:1',directory,headers:{},
      request:async url=>{
        if(url.endsWith('/api/status'))return json({...idle,activeRecording:++statuses===1?initial:{...draft,id:'new-draft'}});
        if(url.endsWith('/api/backups')){backups++;return json({name:'backup-test.json'});}
        assert.ok(initial);assert.ok(url.endsWith('/api/recordings/initial-draft/stop'));flushes++;return json(draft);
      },
      unlock:async()=>{},kill:()=>{stopped=true;},wait:async()=>{}
    }),/recording|busy|session/i);
    assert.equal(statuses,2);assert.equal(flushes,initial?1:0);assert.equal(backups,1);assert.equal(stopped,false);
  });
});

test('restart preserves a recovered recording draft and includes it in the workspace backup',async t=>{
  const storage=path.resolve('.test-output','restart-recovered-recording-'+Date.now());
  const directory=path.join(storage,'data');
  let studio=await createStudio({port:3376,storage});
  t.after(async()=>{await studio?.close();});
  await studio.listen();
  const project=studio.store.projects[0];
  const draft={id:'recovered-draft',projectId:project.id,testId:project.tests[0].id,testName:'Recovered recording',status:'stopped',saving:false,saveError:null,steps:[{action:'navigate',name:'Open saved page',value:'https://example.test/recorded'}],warnings:[]};
  await studio.close();studio=null;
  await writeFile(path.join(directory,'recording.json'),JSON.stringify(draft));
  studio=await createStudio({port:3376,storage});await studio.listen();
  const base='http://127.0.0.1:'+studio.server.address().port;
  const recovered=await (await fetch(base+'/api/status')).json();
  assert.deepEqual(recovered.activeRecording.steps,draft.steps);
  const fakePid=424242;
  await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:fakePid}));
  let stopped=false;
  await restartStudio({
    url:base,directory,headers:{},
    kill:(pid,signal)=>{
      assert.equal(pid,fakePid);
      if(signal===0)throw Object.assign(new Error('Stopped'),{code:'ESRCH'});
      assert.equal(signal,'SIGTERM');stopped=true;
    },wait:async()=>{}
  });
  assert.equal(stopped,true);
  const saved=JSON.parse(await readFile(path.join(directory,'recording.json'),'utf8'));
  assert.equal(saved.status,'stopped');assert.deepEqual(saved.steps,draft.steps);
  const backups=(await readdir(directory)).filter(name=>/^backup-[\w-]+\.json$/.test(name));
  assert.equal(backups.length,1);
  const backup=JSON.parse(await readFile(path.join(directory,backups[0]),'utf8'));
  assert.equal(backup.recording.id,draft.id);assert.deepEqual(backup.recording.steps,draft.steps);
  await studio.close();studio=null;
  studio=await createStudio({port:3376,storage});await studio.listen();
  const reopened=await (await fetch('http://127.0.0.1:'+studio.server.address().port+'/api/status')).json();
  assert.equal(reopened.activeRecording.id,draft.id);assert.deepEqual(reopened.activeRecording.steps,draft.steps);
});

test('restart flushes a live stopped recording into the workspace backup',async t=>{
  const storage=path.resolve('.test-output','restart-live-recording-'+Date.now()),directory=path.join(storage,'data');
  let recording,stops=0;
  const studio=await createStudio({port:3377,storage,recordingLauncher:async(project,testId,url)=>{
    recording={
      id:'live-draft',projectId:project.id,testId,status:'recording',saving:false,saveError:null,
      steps:[{action:'navigate',name:'Recorded starting page',value:url}],
      summary(){const {summary,save,stop,onChange,...data}=this;return structuredClone(data);},
      async save(){await this.onChange?.(this.summary());},
      async stop(){stops++;this.status='stopped';await this.save();return this.summary();}
    };
    return recording;
  }});
  t.after(()=>studio.close());await studio.listen();
  const base='http://127.0.0.1:'+studio.server.address().port,project=studio.store.projects[0];
  const response=await fetch(base+'/api/recordings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,testId:project.tests[0].id,url:'https://example.test/live-recording'})});
  assert.equal(response.status,201);
  // Closing the recorder browser saves its draft file without importing its steps.
  recording.status='stopped';await recording.save();
  assert.equal(studio.store.recording,undefined);
  await writeFile(path.join(directory,'studio.lock'),JSON.stringify({pid:424242}));
  let stopped=false;
  await restartStudio({
    url:base,directory,headers:{},
    kill:(pid,signal)=>{assert.equal(pid,424242);if(signal===0)throw Object.assign(new Error('Stopped'),{code:'ESRCH'});stopped=true;},
    wait:async()=>{}
  });
  assert.equal(stopped,true);assert.equal(stops,1);
  const backups=(await readdir(directory)).filter(name=>/^backup-[\w-]+\.json$/.test(name));
  assert.equal(backups.length,1);
  const backup=JSON.parse(await readFile(path.join(directory,backups[0]),'utf8'));
  assert.equal(backup.recording.id,recording.id);assert.equal(backup.recording.status,'stopped');
  assert.deepEqual(backup.recording.steps,recording.steps);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'recording.json'),'utf8')).steps,recording.steps);
});

test('running server advertises its loaded version and serves both administration routes',async t=>{
  const storage=path.resolve('.test-output','restart-routes-'+Date.now());
  const studio=await createStudio({port:3351,storage,authenticated:false});await studio.listen();t.after(()=>studio.close());
  const base='http://127.0.0.1:3351';
  const session=await (await fetch(base+'/api/auth/session')).json();
  assert.equal(session.runtime.pid,process.pid);
  assert.equal(session.runtime.sourceVersion,await sourceVersion());
  for(const route of ['/admin/permissions','/admin/projects']){
    const anonymous=await fetch(base+route,{redirect:'manual'});
    assert.equal(anonymous.status,302);assert.equal(anonymous.headers.get('location'),'/login');
  }
  const account={name:'Administrator',username:'admin',password:'Restart-regression-password'};
  assert.equal((await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)})).status,201);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const [route,title] of [['/admin/permissions','User permissions'],['/admin/projects','Project management']]){
    const response=await fetch(base+route,{headers:{Cookie:cookie}});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);
    assert.ok((await response.text()).includes('<h1>'+title+'</h1>'));
  }
});
