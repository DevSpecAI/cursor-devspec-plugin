import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectInput } from './project-input.mjs'
import { readProjectContext, selectProjectContext, blockProjectContext, contextFile, endpointIdentity } from './project-context.mjs'
import { folderDefault, prepareCursorProject, findNativeCursorCli } from './project-command.mjs'
import { registerConnection, parseArgs } from './remote-control-state.mjs'
import { findProjectPin, confirmReferenceOnline, parseMcpExecution } from './provenance-assistance.mjs'
const A={id:'11111111-1111-4111-8111-111111111111',name:'Website',organization:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Agency'}}
const B={id:'22222222-2222-4222-8222-222222222222',name:'Website',organization:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Client'}}
const endpoint='https://fixture.invalid/api/mcp?tool_namespace=devspec'
let home,cwd
beforeEach(()=>{home=fs.mkdtempSync(path.join(os.tmpdir(),'cursor-project-'));cwd=path.join(home,'work');fs.mkdirSync(cwd)})
afterEach(()=>fs.rmSync(home,{recursive:true,force:true}))
const hook=(name,args={})=>({conversation_id:'chat',tool_name:name,tool_input:args,cwd})

test('project flags accept equal syntax and never silently discard an invalid explicit choice',()=>{
 assert.equal(parseArgs(['fast-connect','--project=Website'])['project-id'],'Website')
 assert.equal(parseArgs(['fast-connect',`--project-id=${A.id}`])['project-id'],A.id)
 assert.throws(()=>parseArgs(['fast-connect','--project=']),/non-empty/)
 assert.throws(()=>parseArgs(['fast-connect','--project',A.id,'--project',B.id]),/one project/)
})
test('namespace mode does not change endpoint identity or merge different conversations',()=>{
 assert.equal(endpointIdentity(endpoint),'https://fixture.invalid/api/mcp')
 selectProjectContext('a',endpoint,A,'explicit',home);selectProjectContext('b',endpoint,B,'explicit',home)
 assert.equal(readProjectContext('a',endpoint,home).project.id,A.id)
 assert.equal(readProjectContext('b',endpoint,home).project.id,B.id)
 assert.throws(()=>selectProjectContext('a',endpoint,B,'explicit',home),/fresh Cursor/)
 assert.throws(()=>readProjectContext('a','https://other.invalid/api/mcp',home),/another DevSpec server/)
})
test('Cursor native input merge stamps scope without allowing permissions; server guard proves destination',()=>{
 selectProjectContext('chat',endpoint,B,'explicit',home)
 const pre=projectInput('pre',hook('MCP:devspec__get_project_summary'),{home})
 assert.deepEqual(pre,{updated_input:{project_id:B.id}})
 assert.equal(projectInput('before',{...hook('devspec__get_project_summary',JSON.stringify(pre.updated_input)),mcp_server_name:'devspec',mcp_server_url:endpoint},{home}),null)
 const foreign=projectInput('before',{...hook('devspec__get_project_summary',pre.updated_input),mcp_server_name:'other',mcp_server_url:'https://other.invalid'},{home})
 assert.equal(foreign.permission,'deny')
 assert.equal(projectInput('pre',hook('MCP:get_project_summary'),{home}),null,'never infer the server from an unqualified tool name')
 assert.equal(projectInput('before',{...hook('get_project_summary',{}),mcp_server_name:'devspec',url:endpoint},{home}).permission,'deny')
 assert.equal(projectInput('pre',hook('MCP:devspec__get_project_summary',{project_id:A.id}),{home}).permission,'deny')
 assert.equal(projectInput('pre',hook('MCP:other__get_project_summary'),{home}),null)
 assert.equal(projectInput('pre',hook('MCP:devspec__list_projects'),{home}),null)
})
test('registration uses the firing Cursor identity and learns only a valid server receipt',()=>{
 const pre=projectInput('pre',hook('MCP:devspec__register_connection',{project_id:B.id}),{home})
 assert.equal(pre.updated_input.local_id,'chat');assert.equal(pre.updated_input.agent_name,'Cursor')
 assert.equal(pre.permission,undefined)
 assert.equal(projectInput('pre',hook('MCP:devspec__register_connection',{local_id:'another-chat'}),{home}).permission,'deny')
 const args={...pre.updated_input,project_id:B.id}
 const result={content:[{type:'text',text:JSON.stringify({connection_id:'33333333-3333-4333-8333-333333333333',project_id:B.id,project_selection:{version:1,status:'resolved',source:'explicit',project:B}})}]}
 projectInput('after',{...hook('devspec__register_connection',JSON.stringify(args)),mcp_server_name:'devspec',url:endpoint,result_json:JSON.stringify(result)},{home})
 assert.equal(readProjectContext('chat',endpoint,home).project.id,B.id)
})
test('blocked and corrupt state never silently fall through',()=>{
 blockProjectContext('chat',endpoint,'Choose a project',home,true)
 assert.equal(projectInput('pre',hook('MCP:devspec__get_action_items'),{home}).permission,'deny')
 fs.writeFileSync(contextFile('chat',home),'broken')
 assert.equal(projectInput('pre',hook('MCP:devspec__get_action_items'),{home}).permission,'deny')
})
test('register sends greenfield pin as a hint and preserves structured ambiguity',async()=>{
 fs.mkdirSync(path.join(cwd,'.devspec'));fs.writeFileSync(path.join(cwd,'.devspec','project.json'),JSON.stringify({project_id:B.id}))
 let args
 const base={cwd,localId:'chat',projectHome:home,resolveAuth:()=>({ok:true,token:'fixture',mcp_url:endpoint}),emitPhase:async()=>{},persistCapability:()=>({ok:true})}
 const result=await registerConnection({...base,mcpCall:async request=>{args=request.arguments;return{data:{connection_id:A.id,project_id:B.id,project_selection:{version:1,status:'resolved',source:'folder_pin',project:B}},meta:{devspec:{connection_capability:{version:1,value:'fixture'}}}}}})
 assert.equal(result.ok,true);assert.equal(args.pinned_project_id,B.id);assert.equal('project_id' in args,false)
 assert.equal(readProjectContext('chat',endpoint,home).project.id,B.id)
 const selection={version:1,status:'choice_required',reason:'ambiguous_remote',candidates:[A,B]}
 const refused=await registerConnection({...base,localId:'new',mcpCall:async()=>{throw Object.assign(new Error('choose'),{details:{code:'project_choice_required',project_selection:selection}})}})
 assert.deepEqual(refused.project_selection,selection)
})
test('commit checks prefer conversation scope while keeping folder pins as hints',async()=>{
 selectProjectContext('chat',endpoint,B,'explicit',home)
 let sent
 const result=await confirmReferenceOnline('Change [devspec:33333333-3333-4333-8333-333333333333]',{
  cwd,conversationId:'chat',projectHome:home,pin:{projectId:A.id},
  resolveAuth:()=>({ok:true,token:'fixture',mcp_url:endpoint}),
  call:async request=>{sent=request.arguments;return{online:{status:'valid'}}},
 })
 assert.equal(result,'valid');assert.equal(sent.project_id,B.id);assert.equal(sent.pinned_project_id,A.id)
})
test('native text-block claim receipts keep their project and exclude foreign servers',()=>{
 const item='33333333-3333-4333-8333-333333333333'
 const input={tool_name:'devspec__claim_work_item',mcp_server_name:'devspec',tool_input:JSON.stringify({action_item_id:item,pinned_project_id:A.id}),result_json:JSON.stringify({content:[{type:'text',text:JSON.stringify({claim_success:true,project_id:B.id,id:item})}],isError:false})}
 assert.equal(parseMcpExecution(input).successful,true)
 assert.equal(parseMcpExecution(input).projectId,B.id)
 assert.equal(parseMcpExecution({...input,mcp_server_name:'foreign'}).successful,false)
})
test('folder defaults are preview-confirmed and do not retarget a conversation',()=>{
 const selection=selectProjectContext('chat',endpoint,B,'explicit',home)
 const preview=folderDefault('remember',{cwd,selection,home});assert.equal(preview.confirmation_required,true);assert.equal(fs.existsSync(preview.path),false)
 assert.equal(folderDefault('remember',{cwd,selection,home,confirm:true,expected:preview.expected}).ok,true)
 const forget=folderDefault('forget',{cwd,selection,home});fs.writeFileSync(forget.path,JSON.stringify({project_id:A.id}))
 assert.equal(folderDefault('forget',{cwd,selection,home,confirm:true,expected:forget.expected}).confirmation_required,true)
 const current=folderDefault('forget',{cwd,selection,home})
 assert.equal(folderDefault('forget',{cwd,selection,home,confirm:true,expected:current.expected}).ok,true)
 assert.equal(readProjectContext('chat',endpoint,home).project.id,B.id)
})
test('greenfield subdirectories inherit a pin without reading home-level machine state',()=>{
 fs.mkdirSync(path.join(cwd,'.devspec'));fs.writeFileSync(path.join(cwd,'.devspec','project.json'),JSON.stringify({project_id:A.id}))
 const child=path.join(cwd,'src');fs.mkdirSync(child)
 assert.equal(findProjectPin(child,{home,mainWorktree:null}).projectId,A.id)
 fs.rmSync(path.join(cwd,'.devspec'),{recursive:true})
 fs.mkdirSync(path.join(home,'.devspec'));fs.writeFileSync(path.join(home,'.devspec','project.json'),JSON.stringify({project_id:B.id}))
 assert.equal(findProjectPin(child,{home,mainWorktree:null}),null)
})
test('fresh handoff verifies Cursor, never reuses history, and does not claim to launch a chat',async()=>{
 const inspected=[]
 const findCli=()=>{inspected.push(true);return 'cursor-agent'}
 const opts={cwd,auth:{ok:true,token:'fixture',mcp_url:endpoint},call:async()=>({projects:[A,B]}),findCli}
 const ambiguous=await prepareCursorProject('Website',opts);assert.equal(ambiguous.ok,false);assert.equal(inspected.length,0)
 const previous=selectProjectContext('chat',endpoint,A,'explicit',home)
 const prepared=await prepareCursorProject(B.id,opts)
 assert.deepEqual(prepared.launch_argv,['cursor-agent'])
 assert.equal(prepared.first_message,`/devspec.remote --project ${B.id}`)
 assert.equal(prepared.requires_fresh_chat,true)
 assert.deepEqual(readProjectContext('chat',endpoint,home),previous)
 assert.throws(()=>findNativeCursorCli({cwd,spawn:()=>({status:0,stdout:'Grok agent'})}),/Could not find/)
 assert.equal(findNativeCursorCli({cwd,spawn:(_bin,args)=>{assert.deepEqual(args,['--help']);return{status:0,stdout:'Start the Cursor Agent'}}}),'cursor-agent')
})
