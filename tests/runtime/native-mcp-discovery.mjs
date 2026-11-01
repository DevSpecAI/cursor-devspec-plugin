/** Installed Cursor CLI + local plugin + loopback MCP discovery. No model calls. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../..',import.meta.url))
const binary=process.env.CURSOR_TEST_BIN || execFileSync(process.platform==='win32'?'where':'which',['cursor-agent'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]
const home=fs.mkdtempSync(path.join(os.tmpdir(),'cursor-native-discovery-'))
const calls=[]
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk
 // The CLI may also probe its account endpoint during startup. This fixture
 // serves MCP only; those requests are not JSON-RPC and must not crash it.
 if(!req.url.startsWith('/api/mcp')){res.writeHead(404).end();return}
 if(req.method!=='POST'){res.writeHead(405).end();return}
 if(!body){res.writeHead(400).end();return}
 const rpc=JSON.parse(body);calls.push({method:rpc.method,url:req.url})
 if(rpc.id===undefined){res.writeHead(202).end();return}
 const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'DevSpec fixture',version:'1'}}
  :rpc.method==='tools/list'?{tools:[{name:'devspec__get_project_summary',description:'Fixture project summary',inputSchema:{type:'object',properties:{project_id:{type:'string'}}}}]}:{}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}`
try{
 fs.mkdirSync(path.join(home,'.cursor'))
 fs.writeFileSync(path.join(home,'.cursor','mcp.json'),JSON.stringify({mcpServers:{devspec:{url:`${base}/api/mcp?tool_namespace=devspec`,headers:{Authorization:'Bearer fixture-only'}}}}))
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(binary,['--plugin-dir',root,'mcp','list-tools','devspec'],{cwd:home,env:{...process.env,HOME:home,USERPROFILE:home,CURSOR_CONFIG_DIR:path.join(home,'.cursor'),CURSOR_DATA_DIR:path.join(home,'data'),CURSOR_API_KEY:'fixture-only',CURSOR_API_ENDPOINT:base,DEVSPEC_API_URL:base,DEVSPEC_MCP_TOKEN:'fixture-only'},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGTERM'),30000)
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data)
  child.on('error',error=>{clearTimeout(timer);reject(error)})
  child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr})})
 })
 assert.equal(result.code,0,JSON.stringify(result))
 assert.match(result.stdout,/devspec__get_project_summary/)
 assert(calls.some(call=>call.method==='tools/list'&&call.url.includes('tool_namespace=devspec')))
 console.log(JSON.stringify({result:'PASS',method:'installed Cursor CLI --plugin-dir MCP discovery',namespacedToolVisible:true,modelCalls:0,liveRecords:0}))
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true})}
