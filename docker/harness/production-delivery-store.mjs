import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, copyFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const SLUG = /^[a-z][a-z0-9-]{2,47}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,95}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ACTIVE = new Set(['queued','preparing','restoring','upgrading','verifying']);
const UAT_LIMIT = 1;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const unique = prefix => `${prefix}-${randomUUID()}`;

export class ProductionDeliveryError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function fail(code, message, status=400) { throw new ProductionDeliveryError(code, message, status); }
export function allowedFields(body, fields) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k=>!fields.includes(k))) fail('PRODUCTION_INVALID_INPUT','请求字段无效。');
}
function label(value, name, max=500, optional=false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('PRODUCTION_INVALID_INPUT',`${name}无效。`);
  return value.trim();
}
function identity(value) { if (!ID.test(value ?? '')) fail('PRODUCTION_INVALID_ID','记录编号无效。'); return value; }
function deliveryDetails(value) {
  allowedFields(value,['recipient','projectName','purpose']);
  return {recipient:label(value.recipient,'交付对象',160),projectName:label(value.projectName,'交付项目',160),purpose:label(value.purpose,'用途',2000)};
}
function trustedActor(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('PRODUCTION_ACTOR_REQUIRED','缺少可信登录身份。',403);
  return {id:label(value.id,'登录账号标识',191),username:label(value.username,'登录账号',191),displayName:label(value.displayName??value.username,'操作人',191)};
}
function baselineAvailable(job) {
  const baseline=job.baseline;
  return /^[a-f0-9]{64}$/.test(job.manifestSha256??'')&&baseline?.manifestSha256===job.manifestSha256
    &&Array.isArray(baseline.files)&&baseline.files.length===4
    &&['database.sql','redis.rdb','files.tar','secrets.tar'].every(name=>baseline.files.some(file=>file.name===name
      &&Number.isSafeInteger(file.size)&&file.size>=0&&/^[a-f0-9]{64}$/.test(file.sha256??'')));
}
function occupiesEnvironment(job) {return ACTIVE.has(job.status)||Boolean(job.port&&!job.environmentStoppedAt&&job.environment?.status!=='stopped');}
function publicRelease({source,...release}) {return release;}
async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch (error) { if (error.code==='ENOENT' && fallback!==undefined) return fallback; throw error; }
}
async function privateDirectory(dir) { await mkdir(dir,{recursive:true,mode:0o700}); const st=await lstat(dir); if (!st.isDirectory()||st.isSymbolicLink()) fail('PRODUCTION_STORAGE_INVALID','归档目录无效。',503); }
async function immutable(file, value) { await privateDirectory(path.dirname(file)); await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
async function atomic(file,value) {
  await privateDirectory(path.dirname(file)); const tmp=`${file}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); await rename(tmp,file);
}
export async function fileDigest(filename) { const hash=createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function boundedFile(root, relative) {
  if (typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..'||x==='')) fail('PRODUCTION_FILE_INVALID','材料路径无效。',503);
  const base=await realpath(root); const file=await realpath(path.join(base,relative));
  if (!file.startsWith(base+path.sep)) fail('PRODUCTION_FILE_INVALID','材料超出归档范围。',503);
  const st=await lstat(file); if (!st.isFile()||st.isSymbolicLink()) fail('PRODUCTION_FILE_INVALID','材料不是普通文件。',503);
  return {file,size:st.size};
}
function publicJob(job) {
  const {id,project,releaseId,baseJobId,mode,architecture,status,createdAt,updatedAt,environment,stages,manifestSha256,validation,acceptance,error,artifacts,environmentStoppedAt}=job;
  return {id,project,releaseId,baseJobId,mode,architecture,status,createdAt,updatedAt,environment,stages,manifestSha256,validation,acceptance,error,environmentStoppedAt,
    createdBy:job.createdBy??null,delivery:job.delivery??null,sourceArtifact:job.sourceArtifact??null,sourceCandidateId:job.sourceCandidateId??null,baselineAvailable:baselineAvailable(job),environmentSlotOccupied:occupiesEnvironment(job),
    artifacts:(artifacts??[]).map(({key,name,size,sha256})=>({key,name,size,sha256})),retention:'permanent'};
}

/** Dedicated production archive. No remove, overwrite-release, or retention-expiry operation. */
export class ProductionDeliveryStore {
  constructor(config,{launch,clock=now,probe}={}) {
    this.config=config; this.clock=clock; this.launch=launch??this.spawnWorker.bind(this); this.probe=probe??this.probeEnvironment.bind(this); this.pending=new Map(); this.serial=Promise.resolve();
    for(const key of ['archiveRoot','backupRoot','environmentRoot','workerPath']) if(!path.isAbsolute(config[key]??'')) fail('PRODUCTION_CONFIG_INVALID','生产交付配置缺少绝对目录。',503);
    const roots=['archiveRoot','backupRoot','environmentRoot'].map(k=>path.resolve(config[k]));
    if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a===b||a.startsWith(b+path.sep))))) fail('PRODUCTION_CONFIG_INVALID','运行环境与两份归档必须使用独立目录。',503);
    if(!config.projects||typeof config.projects!=='object') fail('PRODUCTION_CONFIG_INVALID','尚未登记生产项目。',503);
  }
  async initialize() {
    for(const root of [this.config.archiveRoot,this.config.backupRoot,this.config.environmentRoot]) await privateDirectory(root);
    // Interrupted work is retained, never silently replayed against a partially migrated DB.
    for(const project of Object.keys(this.config.projects)) for(const job of await this.records(project,'jobs')) if(ACTIVE.has(job.status)) {
      job.status='interrupted';job.updatedAt=this.clock();job.error={code:'PRODUCTION_WORKER_INTERRUPTED',message:'执行服务曾中断。原环境和材料已保留，请查看结果后创建新的验证任务。'};
      await atomic(this.recordPath(project,'jobs',job.id),job);
    }
  }
  project(project) {
    if(!SLUG.test(project??'')||!Object.hasOwn(this.config.projects,project)) fail('PRODUCTION_PROJECT_NOT_FOUND','该项目尚未配置生产交付。',404);
    return this.config.projects[project];
  }
  recordPath(project,kind,id) { this.project(project);identity(id);return path.join(this.config.archiveRoot,project,kind,id,'record.json'); }
  async records(project,kind) {
    this.project(project); const dir=path.join(this.config.archiveRoot,project,kind);
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return[];throw error;}
    const rows=[];for(const entry of entries) if(entry.isDirectory()&&!entry.isSymbolicLink()&&ID.test(entry.name)) {const row=await jsonFile(path.join(dir,entry.name,'record.json'),null);if(row)rows.push(row);}
    return rows.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async record(project,kind,id) { const row=await jsonFile(this.recordPath(project,kind,id),null);if(!row||row.project!==project)fail('PRODUCTION_NOT_FOUND','记录不存在。',404);return row; }
  async event(project,kind,id,type,actor,detail={}) {await appendFile(path.join(path.dirname(this.recordPath(project,kind,id)),'events.jsonl'),JSON.stringify({at:this.clock(),type,actor,detail})+'\n',{mode:0o600});}
  async locked(action) {const run=this.serial.then(action,action);this.serial=run.catch(()=>{});return run;}
  async saved(project,kind,item) {
    await immutable(this.recordPath(project,kind,item.id),item);
    await immutable(path.join(this.config.backupRoot,project,kind,item.id,'record.json'),item);
    return item;
  }
  async dedup(project,action,key,input,operation) {
    label(key,'操作标识',128);const id=digest(action+':'+key), root=path.join(this.config.archiveRoot,project,'requests');
    return this.locked(async()=>{const filename=path.join(root,id+'.json');const existing=await jsonFile(filename,null);const inputHash=digest(JSON.stringify(input));
      if(existing){if(existing.inputHash!==inputHash)fail('PRODUCTION_REQUEST_CONFLICT','操作标识已经用于不同请求。',409);return existing.result;}
      const result=await operation();await immutable(filename,{inputHash,result});return result;
    });
  }
  async candidates(project) {
    const config=this.project(project); const raw=await readFile(config.auditPath??path.join(config.projectRoot,'ops/release-audit.jsonl'),'utf8');
    const images={...config.initialImages};const rows=[];
    for(const line of raw.split('\n')) {if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{continue;}
      if(r.status!=='success'||!COMMIT.test(r.commit??'')||(r.projectSlug&&r.projectSlug!==project))continue;
      for(const [service,item]of Object.entries(r.images??{})){const id=typeof item==='string'?item:item.id;if(IMAGE.test(id??''))images[service]={service,id,reference:typeof item==='object'?item.image:undefined};}
      const services=config.recipe?.application?.services?.map(s=>s.imageService??s.name)??Object.keys(images);
      const complete=services.length>0&&services.every(s=>IMAGE.test((typeof images[s]==='string'?images[s]:images[s]?.id)??''));
      const normalized=services.filter(s=>images[s]).map(service=>typeof images[service]==='string'?{service,id:images[service]}:{...images[service],service});
      // Match the center's artifact identity using this audit row, never carried-forward images.
      const sourceArtifacts=r.type==='controlled-release'&&ID.test(r.jobId??'')?(Array.isArray(r.services)?r.services:[])
        .filter(service=>['forge-admin','forge-ui','forge-app','forge-flow'].includes(service)).flatMap(service=>{
          const image=r.images?.[service];
          if(!image||typeof image!=='object'||!IMAGE.test(image.id??'')||typeof image.image!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/.test(image.image))return[];
          return[{id:'artifact-'+digest(JSON.stringify([project,r.jobId,service,image.id])).slice(0,32),service,imageDigest:image.id,reference:image.image,
            releaseId:'release-'+digest(JSON.stringify([project,r.jobId])).slice(0,32),sourceReleaseJobId:r.jobId,commit:r.commit,version:r.version??null}];
        }):[];
      rows.push({id:'candidate-'+digest(JSON.stringify([project,r.jobId,r.commit,r.version,normalized])).slice(0,32),version:r.version??r.commit.slice(0,12),commit:r.commit,createdAt:r.finishedAt??r.completedAt??r.startedAt,services,images:normalized,
        sourceReleaseJobId:ID.test(r.jobId??'')?r.jobId:null,sourceArtifacts,
        architectures:config.architectures??['amd64'],available:complete,unavailableReason:complete?null:'历史发布未记录完整服务镜像，请先补齐可信版本材料。'});
    }
    return rows.reverse();
  }
  async createRelease(body,actor) {
    allowedFields(body,['project','candidateId','title','notes','idempotencyKey']);const project=body.project;this.project(project);
    const title=label(body.title,'版本名称',120),notes=label(body.notes,'发布说明',4000,true);
    return this.dedup(project,'release',body.idempotencyKey,body,async()=>{
      const source=(await this.candidates(project)).find(r=>r.id===body.candidateId);
      if(!source)fail('PRODUCTION_CANDIDATE_NOT_FOUND','请选择已成功发布的固定测试版本。',404);
      if(!source.available)fail('PRODUCTION_CANDIDATE_INCOMPLETE',source.unavailableReason,409);
      const item={id:unique('release'),project,title,notes,version:source.version,commit:source.commit,candidateId:source.id,source,createdAt:this.clock(),createdBy:actor,retention:'permanent'};
      await this.saved(project,'releases',item);return {item};
    });
  }
  async listReleases(project) {
    const releases=await this.records(project,'releases');
    const jobs=await Promise.all((await this.records(project,'jobs')).map(async job=>ACTIVE.has(job.status)?(await this.getJob(project,job.id)).item:publicJob(job)));
    return {items:releases.map(({source,...r})=>({...r,jobs:jobs.filter(j=>j.releaseId===r.id)}))};
  }
  async listJobs(project) {return{items:await Promise.all((await this.records(project,'jobs')).map(async job=>(await this.getJob(project,job.id)).item))};}
  async capacity(project) {
    this.project(project);const occupied=[];
    for(const configured of Object.keys(this.config.projects))for(const job of await this.records(configured,'jobs'))if(occupiesEnvironment(job))occupied.push(job);
    return {limit:UAT_LIMIT,occupied:occupied.length,available:Math.max(0,UAT_LIMIT-occupied.length),
      items:occupied.filter(job=>job.project===project).map(job=>({jobId:job.id,releaseId:job.releaseId,status:job.status,mode:job.mode}))};
  }
  async releaseDetail(project,id) {
    const {source,...item}=await this.record(project,'releases',id);
    const jobs=await Promise.all((await this.records(project,'jobs')).filter(j=>j.releaseId===id).map(async job=>(await this.getJob(project,job.id)).item));
    return {item,jobs,deployments:(await this.records(project,'deployments')).filter(d=>d.releaseId===id)};
  }
  async createJob(releaseId,body,actor) {
    allowedFields(body,['project','mode','baseJobId','architecture','idempotencyKey']);const project=body.project;this.project(project);
    return this.dedup(project,'job:'+releaseId,body.idempotencyKey,body,async()=>{
      const release=await this.record(project,'releases',releaseId);
      const base=await this.validationBase(project,body),port=await this.validationPort(project);
      return this.startJob(release,body,actor,{base,port});
    });
  }
  async createExport(body,actor) {
    allowedFields(body,['project','candidateId','sourceArtifactId','mode','architecture','baseJobId','delivery','idempotencyKey']);
    const project=body.project;this.project(project);const delivery=deliveryDetails(body.delivery),createdBy=trustedActor(actor);
    // Include the trusted identity in retry matching; another account cannot reuse this request key.
    return this.dedup(project,'export',body.idempotencyKey,{...body,createdBy},async()=>{
      const source=(await this.candidates(project)).find(candidate=>candidate.id===body.candidateId);
      if(!source)fail('PRODUCTION_CANDIDATE_NOT_FOUND','请选择已成功发布的固定测试版本。',404);
      if(!source.available)fail('PRODUCTION_CANDIDATE_INCOMPLETE',source.unavailableReason,409);
      const sourceArtifact=source.sourceArtifacts.find(artifact=>artifact.id===body.sourceArtifactId);
      if(!sourceArtifact||!source.images.some(image=>image.service===sourceArtifact.service&&image.id===sourceArtifact.imageDigest))fail('PRODUCTION_SOURCE_ARTIFACT_MISMATCH','镜像制品不属于所选项目的该次成功发布，请从原制品行重新发起。',409);
      const base=await this.validationBase(project,body),port=await this.validationPort(project);
      const release={id:unique('release'),project,title:source.version,notes:delivery.purpose,version:source.version,commit:source.commit,
        candidateId:source.id,source,createdAt:this.clock(),createdBy,retention:'permanent'};
      // Source, architecture, full baseline and capacity are checked before creating either record.
      await this.saved(project,'releases',release);
      const result=await this.startJob(release,body,createdBy,{base,port,delivery,sourceArtifact});
      return {...result,release:publicRelease(release)};
    });
  }
  async validationBase(project,body) {
    const config=this.project(project);
    if(!['initial','upgrade'].includes(body.mode)||!['amd64','arm64'].includes(body.architecture))fail('PRODUCTION_INVALID_INPUT','请选择安装方式和目标架构。');
    if(!(config.architectures??['amd64']).includes(body.architecture))fail('PRODUCTION_ARCHITECTURE_UNAVAILABLE','当前执行资源尚未支持该架构，不能生成已验证交付包。',409);
    let base=null;
    if(body.mode==='upgrade') {
      if(!body.baseJobId)fail('PRODUCTION_BASELINE_UNAVAILABLE','增量导出必须选择同项目、同架构且已验收的历史全量包；没有合格全量包时不能增量导出。',409);
      base=await this.record(project,'jobs',body.baseJobId);
      if(base.mode!=='initial'||base.status!=='ready'||!baselineAvailable(base)||base.architecture!==body.architecture)fail('PRODUCTION_BASELINE_UNAVAILABLE','请选择同项目、同架构、已验收且保留完整恢复基线的历史全量包，不能选择增量包。',409);
    }
    else if(body.baseJobId)fail('PRODUCTION_INVALID_INPUT','首次安装不接受历史升级起点。');
    return base;
  }
  async validationPort(project) {
    if(!(await this.capacity(project)).available)fail('PRODUCTION_UAT_BUSY','当前服务已有未结束的 UAT 验证环境（最多 1 个）。请先完成现有验证并显式停止环境，再发起新导出；原环境不会自动停止或覆盖。',409);
    const occupied=new Set();for(const p of Object.keys(this.config.projects))for(const job of await this.records(p,'jobs'))if(occupiesEnvironment(job)&&job.port)occupied.add(job.port);
    const end=this.config.portEnd??22999;let port=this.config.portStart??22000;while(occupied.has(port)&&port<=end)port++;
    if(port>end)fail('PRODUCTION_CAPACITY','验证环境端口资源已用完。',409);
    return port;
  }
  async startJob(release,body,actor,{base,port,delivery=null,sourceArtifact=null}) {
      const project=release.project,releaseId=release.id,config=this.project(project);
      const id=unique('job'),jobRoot=path.dirname(this.recordPath(project,'jobs',id));
      const job={id,project,releaseId,baseJobId:base?.id??null,mode:body.mode,architecture:body.architecture,status:'queued',createdAt:this.clock(),updatedAt:this.clock(),createdBy:actor,
        delivery,sourceArtifact,sourceCandidateId:release.candidateId??null,port,stages:[],artifacts:[],validation:null,acceptance:null,error:null,environment:null};
      await this.saved(project,'jobs',job);
      const materials=config.materialSources?.[release.commit];
      const request={schemaVersion:1,action:'validate',jobId:id,project,releaseId,mode:job.mode,architecture:job.architecture,jobRoot,archiveRoot:this.config.archiveRoot,backupRoot:this.config.backupRoot,environmentRoot:this.config.environmentRoot,bindHost:this.config.bindHost,publicHost:this.config.publicHost??this.config.bindHost,port,
        createdAt:job.createdAt,createdBy:actor,delivery,sourceArtifact,sourceCandidateId:job.sourceCandidateId,
        source:{projectRoot:config.projectRoot,commit:release.commit,images:release.source.images,services:release.source.services,...(materials?{materials:{projectRoot:materials.projectRoot,commit:materials.commit}}:{})},base:base?{jobRoot:path.dirname(this.recordPath(project,'jobs',base.id)),manifestSha256:base.manifestSha256,baseline:base.baseline}:null,recipe:materials?.recipe??config.recipe};
      await immutable(path.join(jobRoot,'request.json'),request);await immutable(path.join(this.config.backupRoot,project,'jobs',id,'request.json'),request);
      await this.event(project,'jobs',id,'requested',actor,{mode:job.mode,baseJobId:job.baseJobId,delivery,sourceArtifact,sourceCandidateId:job.sourceCandidateId});
      const promise=Promise.resolve().then(()=>this.launch(request)).then(result=>this.finishJob(project,id,result)).catch(error=>this.failJob(project,id,error));
      this.pending.set(id,promise);promise.finally(()=>this.pending.delete(id)).catch(()=>{});return {item:publicJob(job)};
  }
  async spawnWorker(request) {
    const requestPath=path.join(request.jobRoot,request.action==='stop'?'stop-request.json':'request.json');
    return new Promise((resolve,reject)=>{
      const child=spawn(this.config.python??'python3',[this.config.workerPath,'--request',requestPath],{stdio:['ignore','ignore','ignore'],windowsHide:true});
      child.once('error',()=>reject(new ProductionDeliveryError('PRODUCTION_WORKER_UNAVAILABLE','验证执行器无法启动。',503)));
      child.once('exit',async code=>{try{const result=await jsonFile(path.join(request.jobRoot,request.action==='stop'?'stop-result.json':'result.json'),null);if(!result||code!==0||result.status!=='success'||request.action==='stop'&&result.stopAttemptId!==request.stopAttemptId)reject(Object.assign(new Error('执行失败，请查看任务阶段和诊断。'),{code:result?.error?.code??'PRODUCTION_VALIDATION_FAILED',publicMessage:result?.error?.message}));else resolve(result);}catch(error){reject(error);}});
    });
  }
  async finishJob(project,id,result) {
    const job=await this.record(project,'jobs',id),root=path.dirname(this.recordPath(project,'jobs',id));
    if(result.status!=='success'||result.validation?.status!=='passed'||!/^([a-f0-9]{64})$/.test(result.manifestSha256??'')||!result.environment?.url)fail('PRODUCTION_INVALID_RESULT','缺少真实升级验证结果。',503);
    const required=['bundle','sql','deployment-guide','operation-guide','manifest','verification'];
    if(required.some(k=>!result.artifacts?.some(a=>a.key===k)))fail('PRODUCTION_MATERIALS_MISSING','交付材料不完整。',409);
    for(const a of result.artifacts) {const {file,size}=await boundedFile(root,a.relativePath);if(size!==a.size||await fileDigest(file)!==a.sha256)fail('PRODUCTION_MATERIAL_CHANGED','交付材料校验失败。',409);}
    const manifest=result.artifacts.find(a=>a.key==='manifest');if(manifest.sha256!==result.manifestSha256)fail('PRODUCTION_MANIFEST_CHANGED','版本清单校验失败。',409);
    const baseline=result.baseline;
    if(!baseline||!Array.isArray(baseline.files)||baseline.files.length!==4||['database.sql','redis.rdb','files.tar','secrets.tar'].some(name=>!baseline.files.some(f=>f.name===name)))fail('PRODUCTION_BASELINE_MISSING','缺少完整的数据库、缓存、文件或加密材料历史基线。',409);
    for(const item of baseline.files){const {file,size}=await boundedFile(root,'private-baseline/'+item.name);if(size!==item.size||await fileDigest(file)!==item.sha256)fail('PRODUCTION_BASELINE_CHANGED','历史恢复基线校验失败。',409);}
    // Copy every completed file, including private baseline, to the permanent backup.
    await this.backupTree(project,id,root);
    Object.assign(job,{status:'awaiting-acceptance',updatedAt:this.clock(),artifacts:result.artifacts,manifestSha256:result.manifestSha256,environment:result.environment,validation:result.validation,baseline:result.baseline,error:null});
    await immutable(path.join(this.config.backupRoot,project,'jobs',id,'validation-completed.json'),job);
    await this.event(project,'jobs',id,'validation-passed',null,{manifestSha256:job.manifestSha256});
    // Publish the accept-able state only after all permanent completion writes succeed.
    await atomic(this.recordPath(project,'jobs',id),job);
  }
  async backupTree(project,id,root) {
    const copy=async(dir,relative='')=>{for(const item of await readdir(dir,{withFileTypes:true})){if(item.isSymbolicLink())fail('PRODUCTION_FILE_INVALID','归档包含不允许的链接。',409);const rel=path.join(relative,item.name),src=path.join(dir,item.name),dest=path.join(this.config.backupRoot,project,'jobs',id,'materials',rel);if(item.isDirectory())await copy(src,rel);else if(item.isFile()){await privateDirectory(path.dirname(dest));await copyFile(src,dest,1);}}};await copy(root);
  }
  async failJob(project,id,error) {
    const job=await this.record(project,'jobs',id);job.status='failed';job.updatedAt=this.clock();job.error={code:/^PRODUCTION_[A-Z0-9_]+$/.test(error.code??'')?error.code:'PRODUCTION_VALIDATION_FAILED',message:typeof error.publicMessage==='string'?error.publicMessage.slice(0,500):error instanceof ProductionDeliveryError?error.message:'验证失败，已保留原任务和材料，请查看执行阶段。'};
    const result=await jsonFile(path.join(path.dirname(this.recordPath(project,'jobs',id)),'result.json'),null);if(result?.environment)job.environment=result.environment;
    await atomic(this.recordPath(project,'jobs',id),job);await this.event(project,'jobs',id,'failed',null,job.error);
    await immutable(path.join(this.config.backupRoot,project,'jobs',id,'failure.json'),job);
  }
  async getJob(project,id) {
    const job=await this.record(project,'jobs',id);const progress=await jsonFile(path.join(path.dirname(this.recordPath(project,'jobs',id)),'progress.json'),null);
    if(progress){job.stages=progress.stages??job.stages;if(ACTIVE.has(job.status)&&ACTIVE.has(progress.status))job.status=progress.status;if(progress.environment&&!job.environmentStoppedAt)job.environment={...job.environment,...progress.environment};}
    return {item:publicJob(job)};
  }
  async accept(id,body,actor) {
    allowedFields(body,['project','decision','notes','expectedManifestSha256']);label(body.notes,'验收意见',4000);
    if(!['accepted','rejected'].includes(body.decision))fail('PRODUCTION_INVALID_INPUT','验收结论无效。');
    return this.locked(async()=>{const job=await this.record(body.project,'jobs',id);
      if(job.status!=='awaiting-acceptance'||job.environmentStoppedAt||job.manifestSha256!==body.expectedManifestSha256)fail('PRODUCTION_ACCEPTANCE_CONFLICT','验证尚未完成、环境已停止或材料已变化，请重新查看任务。',409);
      for(const artifact of job.artifacts){const {file}=await boundedFile(path.dirname(this.recordPath(body.project,'jobs',id)),artifact.relativePath);if(await fileDigest(file)!==artifact.sha256)fail('PRODUCTION_MATERIAL_CHANGED','材料已发生变化，不能沿用原验收。',409);}
      if(body.decision==='accepted'&&!await this.probe(job))fail('PRODUCTION_ENVIRONMENT_UNAVAILABLE','验证环境当前不可访问，不能确认验收通过；请先恢复环境或登记验收不通过。',409);
      job.acceptance={decision:body.decision,notes:body.notes,actor,at:this.clock(),manifestSha256:job.manifestSha256};job.status=body.decision==='accepted'?'ready':'rejected';job.updatedAt=this.clock();
      await immutable(path.join(path.dirname(this.recordPath(body.project,'jobs',id)),'acceptance.json'),job.acceptance);await immutable(path.join(this.config.backupRoot,body.project,'jobs',id,'acceptance.json'),job.acceptance);
      await atomic(this.recordPath(body.project,'jobs',id),job);await this.event(body.project,'jobs',id,'human-acceptance',actor,job.acceptance);return{item:publicJob(job)};
    });
  }
  async probeEnvironment(job) {
    const request=await jsonFile(path.join(path.dirname(this.recordPath(job.project,'jobs',job.id)),'request.json'));
    const health=request.recipe?.application?.health;
    if(!health?.path||!job.port)return false;
    try{const response=await fetch(`http://${request.bindHost}:${job.port}${health.path}`,{redirect:'error',signal:AbortSignal.timeout(5000)});await response.body?.cancel();return response.status===(health.expectedStatus??200);}catch{return false;}
  }
  async stop(id,body,actor) {
    allowedFields(body,['project']);
    return this.locked(async()=>{
      const job=await this.record(body.project,'jobs',id);if(ACTIVE.has(job.status)||job.status==='awaiting-acceptance')fail('PRODUCTION_ENVIRONMENT_IN_USE','执行或人工验收期间不能停止验证环境。',409);
      if(job.environmentStoppedAt)return{item:publicJob(job)};
      const root=path.dirname(this.recordPath(body.project,'jobs',id)),request=await jsonFile(path.join(root,'request.json'));
      const stopAttemptId=unique('stop'),stopRequest={...request,action:'stop',stopAttemptId};
      const attemptRoot=path.join(root,'stop-attempts',stopAttemptId),backupAttempt=path.join(this.config.backupRoot,body.project,'jobs',id,'stop-attempts',stopAttemptId);
      await immutable(path.join(attemptRoot,'request.json'),stopRequest);await immutable(path.join(backupAttempt,'request.json'),stopRequest);
      // The fixed file is only the worker's current pointer; each attempt remains immutable above.
      await atomic(path.join(root,'stop-request.json'),stopRequest);
      let result;
      try {
        result=await this.launch(stopRequest);
        if(result?.status!=='success'||result.stopAttemptId!==stopAttemptId)fail('PRODUCTION_STOP_RESULT_INVALID','停止执行器未返回本次操作的成功结果。',503);
      } catch(error) {
        const failed={status:'failed',stopAttemptId,at:this.clock(),error:{code:error.code??'PRODUCTION_STOP_FAILED',message:error.publicMessage??error.message}};
        await immutable(path.join(attemptRoot,'result.json'),failed);await immutable(path.join(backupAttempt,'result.json'),failed);
        await this.event(body.project,'jobs',id,'environment-stop-failed',actor,{stopAttemptId,code:failed.error.code});throw error;
      }
      await immutable(path.join(attemptRoot,'result.json'),result);await immutable(path.join(backupAttempt,'result.json'),result);
      job.environmentStoppedAt=this.clock();job.environment={...job.environment,status:'stopped'};
      await this.event(body.project,'jobs',id,'environment-stopped',actor,{stopAttemptId});await atomic(this.recordPath(body.project,'jobs',id),job);return{item:publicJob(job)};
    });
  }
  async download(project,id,key) {
    const job=await this.record(project,'jobs',id);if(job.status!=='ready')fail('PRODUCTION_NOT_ACCEPTED','该包尚未完成人工验收，不能作为正式生产包下载。',409);
    const artifact=job.artifacts.find(a=>a.key===key);if(!artifact)fail('PRODUCTION_NOT_FOUND','文件不存在。',404);
    const file=await boundedFile(path.dirname(this.recordPath(project,'jobs',id)),artifact.relativePath);
    if(file.size!==artifact.size||await fileDigest(file.file)!==artifact.sha256)fail('PRODUCTION_MATERIAL_CHANGED','归档文件异常，请联系维护人员。',503);
    return {...file,...artifact};
  }
  async createTarget(body,actor) {
    allowedFields(body,['project','name','description','idempotencyKey']);this.project(body.project);const name=label(body.name,'交付对象',120),description=label(body.description,'说明',1000,true);
    return this.dedup(body.project,'target',body.idempotencyKey,body,async()=>({item:await this.saved(body.project,'targets',{id:unique('target'),project:body.project,name,description,createdAt:this.clock(),createdBy:actor})}));
  }
  async deployment(body,actor) {
    allowedFields(body,['project','targetId','releaseId','jobId','occurredAt','databaseStatus','applicationStatus','notes','idempotencyKey','source']);
    const {project}=body;await this.record(project,'targets',body.targetId);const job=await this.record(project,'jobs',body.jobId);
    if(job.status!=='ready'||job.releaseId!==body.releaseId)fail('PRODUCTION_NOT_ACCEPTED','请选择该项目已验收的生产发布包。',409);
    if(!['success','failed','partial','not-required'].includes(body.databaseStatus)||!['success','failed','not-run'].includes(body.applicationStatus)||!Number.isFinite(Date.parse(body.occurredAt)))fail('PRODUCTION_INVALID_INPUT','请输入有效上线时间及数据库、应用结果。');
    const notes=label(body.notes,'上线说明',4000,true);if(body.source&&!['manual','imported'].includes(body.source))fail('PRODUCTION_INVALID_INPUT','上线结果来源无效。');
    return this.dedup(project,'deployment',body.idempotencyKey,body,async()=>({item:await this.saved(project,'deployments',{id:unique('deployment'),project,targetId:body.targetId,releaseId:body.releaseId,jobId:body.jobId,occurredAt:new Date(body.occurredAt).toISOString(),databaseStatus:body.databaseStatus,applicationStatus:body.applicationStatus,notes,source:body.source??'manual',manifestSha256:job.manifestSha256,createdAt:this.clock(),createdBy:actor})}));
  }
}
