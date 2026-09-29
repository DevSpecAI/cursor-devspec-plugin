/** Execute the installed Cursor MCP hook pipeline, not a reimplementation of its merge.
 * Network/protobuf/logging boundaries are fixtures. No host files are modified,
 * no inference runs, and no Cursor/vendor source is copied into this repository.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readProjectContext, contextFile } from '../../hooks/scripts/project-context.mjs'
import { findNativeCursorCli } from '../../hooks/scripts/project-command.mjs'
import { readRepositorySnapshot, storeRepositorySnapshot, repositoryContextTextFile } from '../../hooks/scripts/repository-context.mjs'
const require=createRequire(import.meta.url), root=fileURLToPath(new URL('../..',import.meta.url))
const binary=process.env.CURSOR_TEST_BIN || execFileSync(process.platform==='win32'?'where':'which',['cursor-agent'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]
assert.equal(findNativeCursorCli({cursorBin:binary}),binary,'the actual installed CLI identifies itself as Cursor')
const versionDir=process.env.CURSOR_TEST_VERSION_DIR || path.dirname(fs.realpathSync(binary))
let classSource
for(const file of fs.readdirSync(versionDir).filter(name=>/^\d+\.index\.js$/.test(name))){
 const location=path.join(versionDir,file)
 if(!fs.readFileSync(location,'utf8').includes('`MCP:${t.toolName}`'))continue
 for(const factory of Object.values(require(location).modules ?? {})){
  const source=factory.toString(), marker=source.indexOf('const f=`MCP:${t.toolName}`')
  if(marker<0)continue
  const start=source.lastIndexOf('class ',marker)
  for(let end=source.indexOf('}',marker);end>=0;end=source.indexOf('}',end+1)){
   const candidate=source.slice(start,end+1)
   try{new vm.Script(`(${candidate})`);classSource=candidate;break}catch{}
  }
 }
 if(classSource)break
}
assert(classSource?.includes('updated_input') && classSource.includes('mcp_server_name'),'installed Cursor hook adapter shape changed; inspect it before updating this probe')
const awaiter=classSource.match(/return ([\w$]+)\(this,void 0,void 0,\(function\*/)?.[1]
assert(awaiter)
const asyncGenerator=(self,args,_Promise,generator)=>new Promise((resolve,reject)=>{
 const iterator=generator.apply(self,args??[])
 const step=(method,value)=>{let next;try{next=iterator[method](value)}catch(error){reject(error);return}if(next.done){resolve(next.value);return}Promise.resolve(next.value).then(v=>step('next',v),e=>step('throw',e))}
 step('next')
})
class Wire { constructor(value){Object.assign(this,value)} }
// Run the installed carrier conversion too: it enforces the real 10k host limit.
let carrierFactory
for(const file of fs.readdirSync(versionDir).filter(name=>/^\d+\.index\.js$/.test(name))) {
 carrierFactory=Object.entries(require(path.join(versionDir,file)).modules??{}).find(([id])=>id==='../hooks-carriers/dist/index.js')?.[1]
 if(carrierFactory)break
}
assert(carrierFactory,'installed hook-context carrier module exists')
const carriers={}, steps=Object.fromEntries(['sessionStart','beforeSubmitPrompt','preToolUse','postToolUse','postToolUseFailure'].map(n=>[n,n]))
const carrierRequire=id=>id.includes('hook_additional_context_pb')?{C:Wire}:{_E:steps,Qu:new Set(Object.values(steps))}
carrierRequire.d=(exports,getters)=>{for(const [key,getter]of Object.entries(getters))Object.defineProperty(exports,key,{get:getter})}
carrierFactory({},carriers,carrierRequire)
assert.throws(()=>carriers.JJ({hookEventName:'postToolUse',additionalContext:'x'.repeat(10001)}),carriers.B1,'the installed host enforces the measured 10k limit')
const value=data=>({toJson:()=>data})
const Adapter=vm.runInNewContext(`(${classSource})`,{
 [awaiter]:asyncGenerator,W:{randomUUID},x:{_E:{preToolUse:'preToolUse',beforeMCPExecution:'beforeMCPExecution',afterMCPExecution:'afterMCPExecution',postToolUse:'postToolUse',postToolUseFailure:'postToolUseFailure'}},
 Y:carriers,Ue:(_context,_name,event,text)=>carriers.JJ({hookEventName:event,additionalContext:text}),Le:{warn:()=>{}},De:{iz:Wire,HQ:Wire,_Z:Wire,zN:Wire,QW:Wire},Ne:{WT:{fromJson:value}},H:(_label,message)=>message,R:message=>message,V:n=>n,z:{performance},Buffer,
})
const home=fs.mkdtempSync(path.join(os.tmpdir(),'cursor-installed-hooks-'))
const endpoint='https://fixture.invalid/api/mcp?tool_namespace=devspec', cid=randomUUID()
const project={id:'22222222-2222-4222-8222-222222222222',name:'Website',organization:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Client'}}
const config=JSON.parse(fs.readFileSync(path.join(root,'hooks/hooks.json'),'utf8'))
const helper=path.join(root,'hooks/scripts/project-input.mjs')
const requests=[],events=[]
let failPre=false
const hookExecutor={
 hasFailClosedHooksForStep:(step,name)=>config.hooks[step]?.some(h=>h.failClosed===true&&new RegExp(h.matcher).test(name)),
 executeHookForStep:async(step,input)=>{
  events.push({step,input})
  if(failPre&&step==='preToolUse')throw new Error('fixture unavailable hook')
  const mode={preToolUse:'pre',beforeMCPExecution:'before',afterMCPExecution:'after'}[step]
  if(!mode && step!=='postToolUse')return undefined
  const argv=step==='postToolUse'?[path.join(root,'hooks/scripts/repository-context.mjs')]:[helper,mode]
  const output=execFileSync(process.execPath,argv,{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,CURSOR_VERSION:path.basename(versionDir)}}).trim()
  return output?JSON.parse(output):undefined
 }
}
const adapter=new Adapter({execute:async(_context,args)=>{
 const input=Object.fromEntries(Object.entries(args.args).map(([key,v])=>[key,v.toJson()]))
 requests.push({server:args.providerIdentifier,name:args.toolName,args:input})
 const data=args.toolName==='devspec__register_connection'?{connection_id:randomUUID(),project_id:project.id,repository_context:{version:1,project_id:project.id,status:'available',repositories:Array.from({length:25},(_,i)=>({id:`r${i}`,full_name:`org/repo-${i}`,provider:'github',git_url:`https://example.test/repo-${i}.git`,target_branch:'staging',default_branch:'main'}))},project_agent_rules:'Fixture project rules',project_selection:{version:1,status:'resolved',source:'explicit',project}}:{project_id:input.project_id}
 return {result:{case:'success',value:{isError:false,content:[{content:{case:'text',value:{text:JSON.stringify(data)}}}]}}}
}},hookExecutor,()=>({conversation_id:cid,cwd:home,cursor_version:path.basename(versionDir)}),{getClient:async()=>({config:{url:endpoint}})})
const modelContext=[]
const invoke=(name,args={},server='devspec')=>adapter.execute({},{toolName:name,providerIdentifier:server,args:Object.fromEntries(Object.entries(args).map(([k,v])=>[k,value(v)]))},{hookContextCollector:modelContext})
try{
 // Real native pipeline proves registration identity before the first saved scope.
 await invoke('devspec__register_connection',{project_id:project.id})
 assert.equal(requests.at(-1).args.local_id,cid);assert.equal(requests.at(-1).args.agent_name,'Cursor')
 assert.equal(readProjectContext(cid,endpoint,home).project.id,project.id)
 // Restore an undelivered snapshot to probe the post-result model-context lane,
 // separately from the raw registration result that already contains the inventory.
 fs.rmSync(`${contextFile(cid,home)}.repositories.delivered`,{force:true})
 modelContext.length=0
 await invoke('devspec__get_project_summary')
 assert.match(JSON.stringify(modelContext),/repo-24/,'installed host must collect postToolUse.additional_context for the model')
 assert.match(JSON.stringify(modelContext),/Fixture project rules/)
 assert.equal(requests.at(-1).args.project_id,project.id)
 assert.equal(events.find(e=>e.step==='preToolUse').input.mcp_server_name,undefined,'native generic input hook omits provider identity')
 assert.equal(events.find(e=>e.step==='beforeMCPExecution').input.mcp_server_name,'devspec')
 const saved=readRepositorySnapshot(cid,home)
 storeRepositorySnapshot(cid,{project_id:project.id,repository_context:{version:1,project_id:project.id,...saved.repository_context},project_agent_rules:'Full rule '.repeat(2500)+'RULE-END'},home)
 modelContext.length=0
 await invoke('devspec__get_project_summary')
 assert.match(JSON.stringify(modelContext),/10000-character hook limit/)
 assert.match(JSON.stringify(modelContext),/repo-24/)
 assert.match(fs.readFileSync(repositoryContextTextFile(cid,home),'utf8'),/RULE-END/)
 const sent=requests.length
 assert.equal((await invoke('devspec__get_project_summary',{project_id:'11111111-1111-4111-8111-111111111111'})).result.case,'permissionDenied')
 assert.equal((await invoke('devspec__get_project_summary',{},'foreign')).result.case,'permissionDenied')
 assert.equal(requests.length,sent,'neither wrong scope nor spoofed namespace may reach a server')
 failPre=true
 assert.equal((await invoke('devspec__get_project_summary')).result.case,'permissionDenied')
 assert.equal(requests.length,sent,'missing required namespaced hook fails closed')
 console.log(JSON.stringify({result:'PASS',hostVersion:path.basename(versionDir),method:'installed Cursor MCP hook executor in isolated harness',nativeInputMerge:true,serverIdentityGuard:true,registrationReceipt:true,repositoryContextInNativeCarrier:true,wrongScopeDenied:true,hookFailureClosed:true,modelCalls:0,liveRecords:0}))
}finally{fs.rmSync(home,{recursive:true,force:true})}
