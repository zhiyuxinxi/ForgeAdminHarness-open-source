import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createNativeConversationIntentInterpreter } from '../docker/harness/forge-conversation-intent-model.mjs';

const selection={provider:'deepseek-official',model:'deepseek-v4-pro'};
const input={taskId:'c-sample',dshSessionId:'session-sample',currentUserMessage:'继续发布，复用已完成的测试。',previousTask:{goal:'修复并发布',actionCeiling:'release',active:true}};
const decision={kind:'execute',continuity:'same-task',goal:'修复并发布',requestedAction:'release',actionEvidence:'发布',prohibitedActions:[],managedFiles:null,businessDataOperation:null};
const body=(overrides={})=>({id:'ds-request-1',model:selection.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}],...overrides});
function create(options={}){
  return createNativeConversationIntentInterpreter({harnessHome:path.resolve('fixture-home'),proxyEnv:{},
    readModelSelection:async sid=>{assert.equal(sid,input.dshSessionId);return selection;},
    readDeepSeekCredential:async()=>({token:'fixture-deepseek'}),
    readCredential:async()=>{throw new Error('Codex credentials must not be read for DeepSeek');},...options});
}

test('selected native DeepSeek uses its protected credential and one bounded JSON call',async()=>{
  let calls=0;
  const interpret=create({fetchImpl:async(url,request)=>{
    calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.authorization,'Bearer fixture-deepseek');
    const sent=JSON.parse(request.body);assert.equal(sent.model,selection.model);
    assert.equal(sent.response_format.type,'json_object');assert.equal(sent.stream,false);
    assert.deepEqual(JSON.parse(sent.messages[1].content),{currentUserMessage:input.currentUserMessage,previousTask:input.previousTask});
    return Response.json(body());
  }});
  assert.deepEqual(await interpret(input),{provider:selection.provider,model:selection.model,providerRequestId:'ds-request-1',decision});
  assert.equal(calls,1);
});

test('Codex selection preserves the existing Responses terminal contract regardless of user model text',async()=>{
  let calls=0;
  const interpret=create({readModelSelection:async()=>({provider:'openai-codex',model:'gpt-5.6-sol'}),
    readCredential:async()=>({token:'fixture-codex',accountId:'fixture-account'}),
    readDeepSeekCredential:async()=>{assert.fail('must not read DeepSeek credential');},
    fetchImpl:async(url,request)=>{
      calls++;assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(request.headers['chatgpt-account-id'],'fixture-account');
      const terminal={type:'response.completed',response:{id:'resp-fixture',model:'gpt-5.6-sol',status:'completed',output:[{
        type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(decision)}]}]}};
      return new Response(`data: ${JSON.stringify(terminal)}\n\n`);
    }});
  assert.equal((await interpret({...input,currentUserMessage:'用 deepseek 发布'})).provider,'openai-codex');assert.equal(calls,1);
});

test('DeepSeek V4 Flash accepts its observed official response alias without accepting other model mismatches',async()=>{
  let calls=0;
  const interpret=create({readModelSelection:async()=>({provider:'deepseek-official',model:'deepseek-v4-flash'}),
    fetchImpl:async(_url,request)=>{
      calls++;assert.equal(JSON.parse(request.body).model,'deepseek-v4-flash');
      return Response.json(body({model:'deepseek-flash'}));
    }});
  assert.deepEqual(await interpret(input),{provider:'deepseek-official',model:'deepseek-flash',providerRequestId:'ds-request-1',decision});
  assert.equal(calls,1);
  for(const [selected,returned] of [['deepseek-v4-flash','deepseek-pro'],['deepseek-v4-flash','deepseek-v4-pro'],
    ['deepseek-v4-pro','deepseek-flash'],['deepseek-flash','deepseek-v4-flash']]){
    let attempts=0;
    const mismatch=create({readModelSelection:async()=>({provider:'deepseek-official',model:selected}),
      fetchImpl:async()=>{attempts++;return Response.json(body({model:returned}));}});
    await assert.rejects(mismatch(input),{code:'CONVERSATION_INTENT_UNAVAILABLE'});
    assert.equal(attempts,1);
  }
});

test('missing or failed native selection makes no provider request and never falls back',async()=>{
  for(const readModelSelection of [async()=>null,async()=>{throw new Error('native unavailable');}]){
    let calls=0;const interpret=create({readModelSelection,fetchImpl:async()=>{calls++;}});
    await assert.rejects(interpret(input),{code:'CONVERSATION_INTENT_UNAVAILABLE'});assert.equal(calls,0);
  }
});

test('DeepSeek rejection, wrong identity, truncation, tool calls and oversized output do not create a result or retry',async()=>{
  const cases=[()=>new Response('quota',{status:429}),()=>Response.json(body({model:'other-model'})),
    ()=>Response.json(body({choices:[{finish_reason:'length',message:{content:JSON.stringify(decision)}}]})),
    ()=>Response.json(body({choices:[{finish_reason:'stop',message:{content:'{}',tool_calls:[{}]}}]})),
    ()=>Response.json(body({id:''})),()=>new Response('x'.repeat(131073))];
  for(const response of cases){let calls=0;const interpret=create({fetchImpl:async()=>{calls++;return response();}});
    await assert.rejects(interpret(input),{code:'CONVERSATION_INTENT_UNAVAILABLE'});assert.equal(calls,1);}
});

test('unreadable DeepSeek secret prevents network dispatch without exposing its error',async()=>{
  let calls=0;const interpret=create({readDeepSeekCredential:async()=>{throw new Error('private detail');},fetchImpl:async()=>{calls++;}});
  await assert.rejects(interpret(input),error=>error.code==='CONVERSATION_INTENT_UNAVAILABLE'&&!error.message.includes('private detail'));
  assert.equal(calls,0);
});
