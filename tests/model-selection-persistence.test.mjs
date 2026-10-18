import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { readSessionModelSelection, saveSessionModelSelection, patchSessionModelPersistence } from '../docker/harness/forge-model-selection-patch.mjs';

const selected={provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'};
const legacy={provider:'openai-codex',model:'gpt-5.6-sol'};
const fixture=`function selectionFor(agent) {
\t\tlet picked;
\t\tconst selection = {
get current(){if(picked!==undefined)return picked;return agent.session.requestHeader()?.config??defaults.defaultModelSelection();},
set current(next){picked=next;}};return selection;}
function select(found,selected){
\t\t\t\t\t\tselectionFor(found.agent).current = selected;
return selected;}`;

test('session selection survives a fresh process and stays isolated from another session',()=>{
 const home=mkdtempSync(join(tmpdir(),'forge-model-state-'));
 try{
  assert.equal(readSessionModelSelection('session-a',home),undefined);
  saveSessionModelSelection('session-a',selected,home);saveSessionModelSelection('session-b',legacy,home);
  const module=pathToFileURL(resolve('docker/harness/forge-model-selection-patch.mjs')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import{readSessionModelSelection as read}from${JSON.stringify(module)};console.log(JSON.stringify([read('session-a',process.argv[1]),read('session-b',process.argv[1])]));`,home],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),[selected,legacy]);
  if(process.platform!=='win32')assert.equal(statSync(join(home,'model-selections/session-a.json')).mode&0o777,0o600);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('patched native selection prefers saved choice over old request while legacy fallback remains',()=>{
 const patched=patchSessionModelPersistence(fixture), context={
  readSessionModelSelection:id=>id==='saved'?selected:undefined,
  saveSessionModelSelection:()=>{},defaults:{defaultModelSelection:()=>legacy}};
 vm.createContext(context);vm.runInContext(patched.replace(/^import[^\n]+\n/u,''),context);
 const agent=id=>({session:{id,requestHeader:()=>({config:legacy})}});
 assert.deepEqual(context.selectionFor(agent('saved')).current,selected);
 assert.deepEqual(context.selectionFor(agent('old')).current,legacy);
 assert.equal(patchSessionModelPersistence(patched),patched);
 assert.throws(()=>patchSessionModelPersistence(fixture+fixture),/Unsupported/);
});

test('failed preference persistence cannot report a successful model switch',()=>{
 const context={readSessionModelSelection:()=>undefined,saveSessionModelSelection:()=>{throw Error('disk failure');},defaults:{defaultModelSelection:()=>legacy}};
 vm.createContext(context);vm.runInContext(patchSessionModelPersistence(fixture).replace(/^import[^\n]+\n/u,''),context);
 assert.throws(()=>context.select({agent:{session:{id:'session-a'}}},selected),/disk failure/);
});

test('invalid paths and malformed stored preferences fail without replacing a valid choice',()=>{
 const home=mkdtempSync(join(tmpdir(),'forge-model-state-'));
 try{
  saveSessionModelSelection('session-a',selected,home);
  const file=join(home,'model-selections/session-a.json'),before=readFileSync(file,'utf8');
  assert.throws(()=>saveSessionModelSelection('../escape',selected,home),/location/);
  assert.throws(()=>saveSessionModelSelection('session-a',{provider:'x',model:'y',token:'forbidden'},home),/Invalid/);
  assert.equal(readFileSync(file,'utf8'),before);
  writeFileSync(file,'{"provider":false}');assert.throws(()=>readSessionModelSelection('session-a',home),/Invalid/);
 }finally{rmSync(home,{recursive:true,force:true});}
});
