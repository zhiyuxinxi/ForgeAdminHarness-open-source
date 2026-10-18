import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationIntentResolver, conversationIntentAuthority, validateConversationIntent } from '../docker/harness/forge-conversation-intent.mjs';

const decision = overrides => ({kind:'execute',continuity:'new-task',goal:'修复当前页面',requestedAction:null,
  actionEvidence:'',prohibitedActions:[],managedFiles:null,businessDataOperation:null,...overrides});
const previous = {goal:'修复当前页面并发布',actionCeiling:'release',active:true};
test('same-task continuation preserves the endpoint; new work cannot inherit it', () => {
  assert.equal(conversationIntentAuthority(decision({continuity:'same-task'}),previous).actionCeiling,'release');
  assert.equal(conversationIntentAuthority(decision({goal:'新增用户管理'}),previous).actionCeiling,'git-checkpoint');
  assert.equal(conversationIntentAuthority(decision({requestedAction:'workspace-write'}),previous).actionCeiling,'git-checkpoint');
});
test('current prohibitions cap publication, checkpoint and write independently', () => {
  assert.equal(conversationIntentAuthority(decision({requestedAction:'release',prohibitedActions:['release']}),previous).actionCeiling,'git-checkpoint');
  assert.equal(conversationIntentAuthority(decision({requestedAction:'release',prohibitedActions:['git-checkpoint']}),previous).actionCeiling,'workspace-write');
  assert.equal(conversationIntentAuthority(decision({prohibitedActions:['workspace-write']}),previous).actionCeiling,'read-only');
});
test('questions, planning, pause and cancellation never create write authority', () => {
  for(const kind of ['observe','plan','pause','cancel','clarify']) assert.equal(conversationIntentAuthority(decision({kind}),previous).writable,false);
});
test('a request can explicitly resume a paused same task, but cancellation removes context', () => {
  assert.equal(conversationIntentAuthority(decision({continuity:'same-task'}),{...previous,active:false,paused:true}).actionCeiling,'release');
  assert.equal(conversationIntentAuthority(decision({continuity:'same-task'}),null).actionCeiling,'git-checkpoint');
});
test('actions and managed paths must quote the actual current user message', () => {
  assert.throws(()=>validateConversationIntent(decision({requestedAction:'release',actionEvidence:'发布'}),'这是历史问题'),{code:'CONVERSATION_INTENT_INVALID'});
  assert.throws(()=>validateConversationIntent(decision({managedFiles:{operation:'write',targetPaths:['/other']}}),'修复 /reports/a'),{code:'CONVERSATION_INTENT_INVALID'});
  assert.deepEqual(validateConversationIntent(decision({managedFiles:{operation:'write',targetPaths:['/reports/日志说明.md']}}),'修改 /reports/日志说明.md，保留其他日志。').managedFiles.targetPaths,['/reports/日志说明.md']);
});
test('non-execution output cannot smuggle an action, file removal or data mutation', () => {
  for(const override of [{requestedAction:'release',actionEvidence:'发布'}, {businessDataOperation:'apply'}, {managedFiles:{operation:'remove',targetPaths:['/reports/a']}}]) {
    const normalized=validateConversationIntent(decision({kind:'observe',...override}),'发布 /reports/a');
    assert.equal(normalized.requestedAction,null);
    assert.equal(normalized.managedFiles,null);
    assert.equal(normalized.businessDataOperation,null);
    assert.equal(conversationIntentAuthority(normalized,previous).actionCeiling,'read-only');
  }
});
test('one semantic request per RPC, immutable input, and context isolated by actual actor/session', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'forge-intent-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const seen=[];
  const resolve=createConversationIntentResolver({stateRoot:root,interpret:async input=>{
    seen.push(input);return {provider:'fixture',model:'fixture',providerRequestId:`fixture-${seen.length}`,
      decision:decision(input.currentUserMessage==='第一次' ? {requestedAction:'release',actionEvidence:'第一次'}
        : input.currentUserMessage==='新方案' ? {kind:'plan',continuity:'new-task',goal:'另一任务'} : {continuity:'same-task'})};
  }});
  const input={projectSlug:'p',taskId:'t',actorUserId:'u',actorUsername:'owner',conversationId:'c',dshSessionId:'s',rpcId:'1',promptText:'第一次'};
  const [a,b]=await Promise.all([resolve(input),resolve(input)]); assert.deepEqual(a,b); assert.equal(seen.length,1);
  await assert.rejects(resolve({...input,promptText:'改变原文'}),{code:'CONVERSATION_INTENT_INVALID'});
  assert.equal((await resolve({...input,rpcId:'2',promptText:'继续'})).resolved.actionCeiling,'release');
  assert.equal((await resolve({...input,actorUserId:'other',rpcId:'3',promptText:'继续'})).resolved.actionCeiling,'git-checkpoint');
  assert.equal(seen.at(-1).previousTask,null);
  await resolve({...input,rpcId:'4',promptText:'新方案'});
  assert.equal((await resolve({...input,rpcId:'5',promptText:'开始'})).resolved.actionCeiling,'git-checkpoint');
  assert.equal(seen.at(-1).previousTask.goal,'另一任务');
});
