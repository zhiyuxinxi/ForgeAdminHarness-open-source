import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CONVERSATION_INTENT_INSTRUCTIONS } from './forge-conversation-intent.mjs';
import { codexReviewFetch, readCodexReviewResponse } from './forge-independent-semantic-review.mjs';

const MODEL = 'gpt-5.6-sol';
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
function unavailable() { return Object.assign(new Error('平台未能读取本轮用户意图，未新增执行权限；请保留当前任务并报告此平台错误，不要求重复授权。'),
  { code:'CONVERSATION_INTENT_UNAVAILABLE', status:503 }); }
async function privateText(filename, maximum) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum
      || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw unavailable();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function credentialFromHome(harnessHome) {
  const filename = path.join(harnessHome,'.credentials.yaml');
  await privateText(filename,65536);
  const require = createRequire('/opt/forge-harness-runtime/package.json');
  const [cordis,credentials,local] = await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-credentials-local']
    .map(name => import(pathToFileURL(require.resolve(name)).href)));
  const ctx = new cordis.Context();
  try {
    await ctx.plugin(local.LocalCredentialProvider,{path:filename,watch:false});
    const resolved = await ctx.credentials.resolve(credentials.credentialRef('FORGE_CODEX_CLI_ACCESS_TOKEN'));
    const token = resolved?.value;
    if (typeof token !== 'string' || token.length > 32768 || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) throw unavailable();
    const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()+60000
      || typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(accountId)) throw unavailable();
    return {token,accountId};
  } finally { await ctx.fiber.dispose(); }
}

async function boundedJson(body, maximum) {
  const chunks=[];let bytes=0;
  for await(const chunk of body){bytes+=chunk.length;if(bytes>maximum)throw unavailable();chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Read the actual native selection, never a provider named inside user text.
async function selectionFromSession(sessionId, signal) {
  if(typeof sessionId!=='string'||!/^session-[A-Za-z0-9-]{1,160}$/u.test(sessionId))throw unavailable();
  const response=await fetch('http://127.0.0.1:3080/api/session.models',{
    method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),
    headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',
      rpcId:`intent-model-${sessionId}`,method:'session.models',payload:{sessionId}}),
  });
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw unavailable();}
  const result=await boundedJson(response.body,1024*1024);
  if(result.result?.ok!==true)throw unavailable();
  return result.result.value?.current;
}

async function deepSeekCredential() {
  // Reuse the protected secret mounted for the native DeepSeek provider.
  // docker exec does not inherit the startup script's exported API key.
  const handle=await open('/run/secrets/deepseek-api-key',constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.size<16||stat.size>4096
      ||(process.platform!=='win32'&&(stat.mode&0o027)!==0))throw unavailable();
    const key=(await handle.readFile('utf8')).trim();
    if(!/^[A-Za-z0-9_-]+$/u.test(key))throw unavailable();
    return {token:key};
  }finally{await handle.close();}
}

export function createNativeConversationIntentInterpreter({harnessHome=process.env.DSH_HOME,fetchImpl=codexReviewFetch,
  readCredential=credentialFromHome,readModelSelection=selectionFromSession,readDeepSeekCredential=deepSeekCredential,proxyEnv=process.env} = {}) {
  if (typeof harnessHome !== 'string' || !path.isAbsolute(harnessHome)) throw unavailable();
  return async (input,signal) => {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(input.taskId)) throw unavailable();
    let credential;
    try {
      const transportEnv = Object.fromEntries(['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','NO_PROXY','no_proxy'].filter(key => typeof proxyEnv[key] === 'string').map(key => [key,proxyEnv[key]]));
      const timeout = AbortSignal.timeout(60000);
      const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
      const selection=await readModelSelection(input.dshSessionId,requestSignal);
      if(typeof selection?.provider!=='string'||typeof selection.model!=='string')throw unavailable();
      const userInput=JSON.stringify({currentUserMessage:input.currentUserMessage,previousTask:input.previousTask});
      if(selection.provider==='deepseek-official'){
        if(!/^deepseek-[a-z0-9-]{1,80}$/u.test(selection.model))throw unavailable();
        credential=await readDeepSeekCredential();
        const response=await fetchImpl(DEEPSEEK_ENDPOINT,{method:'POST',redirect:'error',signal:requestSignal,
          headers:{authorization:`Bearer ${credential.token}`,'content-type':'application/json'},
          body:JSON.stringify({model:selection.model,stream:false,thinking:{type:'disabled'},max_tokens:4096,
            response_format:{type:'json_object'},messages:[{role:'system',content:CONVERSATION_INTENT_INSTRUCTIONS},{role:'user',content:userInput}]})},transportEnv);
        if(!response.ok){await response.body?.cancel().catch(()=>{});throw unavailable();}
        const result=await boundedJson(response.body,131072);
        // The official V4 Flash endpoint returns its canonical model name.
        const modelMatches=result.model===selection.model
          ||(selection.model==='deepseek-v4-flash'&&result.model==='deepseek-flash');
        if(!/^[A-Za-z0-9._:-]{1,160}$/u.test(result.id??'')||!modelMatches||result.choices?.length!==1
          ||result.choices[0].finish_reason!=='stop'||typeof result.choices[0].message?.content!=='string'
          ||result.choices[0].message.tool_calls?.length)throw unavailable();
        return {provider:selection.provider,model:result.model,providerRequestId:result.id,decision:JSON.parse(result.choices[0].message.content)};
      }
      // Keep the existing Codex interpreter for other native model selections.
      credential = await readCredential(harnessHome);
      const response = await fetchImpl(ENDPOINT,{method:'POST',redirect:'error',
        signal:requestSignal,
        headers:{authorization:`Bearer ${credential.token}`,'chatgpt-account-id':credential.accountId,
          originator:'forge-conversation-intent','OpenAI-Beta':'responses=experimental',accept:'text/event-stream','content-type':'application/json'},
        body:JSON.stringify({model:MODEL,store:false,stream:true,instructions:CONVERSATION_INTENT_INSTRUCTIONS,
          reasoning:{effort:'low'},tools:[],tool_choice:'none',parallel_tool_calls:false,text:{verbosity:'low'},
          input:[{role:'user',content:[{type:'input_text',text:userInput}]}]})},transportEnv);
      if (!response.ok) {await response.body?.cancel().catch(()=>{});throw unavailable();}
      const {id,finalText} = await readCodexReviewResponse(response.body,MODEL);
      return {provider:'openai-codex',model:MODEL,providerRequestId:id,decision:JSON.parse(finalText)};
    } catch {throw unavailable();}
    finally {credential=null;}
  };
}

// Manager remains network-isolated. This is a fixed platform worker in the
// existing task container, no shell and no model-controlled command arguments.
export function createManagerConversationIntentInterpreter() {
  return async (input,signal) => {
    if (![input.projectSlug,input.taskId].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value))) throw unavailable();
    return new Promise((resolve,reject) => {
      const child=spawn('docker',['exec','-i',`forge-${input.projectSlug}-task-${input.taskId}-harness-1`,
        'node','/usr/local/lib/forge-conversation-intent-model.mjs'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
      const chunks=[];let bytes=0,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{child.kill('SIGTERM');finish(unavailable());};
      const timer=setTimeout(abort,70000);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)abort();else chunks.push(chunk);});
      child.stderr.on('data',()=>{});
      child.on('error',()=>finish(unavailable()));child.stdin.on('error',()=>finish(unavailable()));
      child.on('close',code=>{if(code!==0)return finish(unavailable());try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(unavailable());}});
      if(signal?.aborted)return abort();
      child.stdin.end(JSON.stringify(input));
    });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The worker deadline also ends an orphaned docker-exec process.
  const deadline=setTimeout(()=>process.exit(1),65000);
  try {
    let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>2*1024*1024)throw unavailable();}
    const result=await createNativeConversationIntentInterpreter()(JSON.parse(text));
    process.stdout.write(JSON.stringify(result));
  } catch {process.stderr.write('CONVERSATION_INTENT_UNAVAILABLE');process.exitCode=1;}
  finally {clearTimeout(deadline);}
}
