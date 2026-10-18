import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile,chmod,chown,lstat,mkdir,unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ProductionDeliveryStore,ProductionDeliveryError,fail } from './production-delivery-store.mjs';

const PREFIX='/forge-gateway/api/production/';
const MAX_BODY=96*1024;
function send(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));}
async function bodyJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)fail('PRODUCTION_BODY_TOO_LARGE','提交内容过大。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('PRODUCTION_INVALID_INPUT','请求JSON无效。');}}
function actorOf(req){try{const a=JSON.parse(Buffer.from(req.headers['x-production-actor']??'','base64url'));if(typeof a.id!=='string'||typeof a.username!=='string'||!a.id||!a.username||Object.keys(a).some(k=>!['id','username','displayName'].includes(k)))throw new Error();return {id:a.id,username:a.username,displayName:typeof a.displayName==='string'?a.displayName:a.username};}catch{fail('PRODUCTION_ACTOR_REQUIRED','缺少可信登录身份。',403);}}
function rangeOf(raw,size){if(!raw)return{start:0,end:size-1,partial:false};const match=/^bytes=(\d*)-(\d*)$/.exec(raw);if(!match||(!match[1]&&!match[2]))fail('PRODUCTION_RANGE_INVALID','下载范围无效。',416);let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));let end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)fail('PRODUCTION_RANGE_INVALID','下载范围超出文件。',416);return{start,end,partial:true};}

export function createProductionDeliveryServer({store}) {
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://private');if(!url.pathname.startsWith(PREFIX))fail('PRODUCTION_NOT_FOUND','入口不存在。',404);
      if(!['GET','POST'].includes(req.method))fail('PRODUCTION_METHOD_INVALID','操作方式无效。',405);
      const route=url.pathname.slice(PREFIX.length),body=req.method==='POST'?await bodyJson(req):null,project=body?.project??url.searchParams.get('project');store.project(project);
      if([...url.searchParams.keys()].some(k=>!['project','file','targetId'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))fail('PRODUCTION_INVALID_INPUT','查询参数无效。');
      const actor=req.method==='POST'?actorOf(req):null;let output;
      if(route==='candidates'&&req.method==='GET')output={items:await store.candidates(project)};
      else if(route==='exports'&&req.method==='POST')output=await store.createExport(body,actor);
      else if(route==='capacity'&&req.method==='GET')output=await store.capacity(project);
      else if(route==='jobs'&&req.method==='GET')output=await store.listJobs(project);
      else if(route==='releases')output=req.method==='GET'?await store.listReleases(project):await store.createRelease(body,actor);
      else if(route==='targets')output=req.method==='GET'?{items:await store.records(project,'targets')}:await store.createTarget(body,actor);
      else if(route==='deployments')output=req.method==='GET'?{items:(await store.records(project,'deployments')).filter(d=>!url.searchParams.get('targetId')||d.targetId===url.searchParams.get('targetId'))}:await store.deployment(body,actor);
      else{
        const match=/^(releases|jobs)\/([a-z0-9-]+)(?:\/(jobs|acceptance|stop|download))?$/.exec(route);if(!match)fail('PRODUCTION_NOT_FOUND','入口不存在。',404);
        const [,kind,id,action]=match;
        if(kind==='releases'&&!action&&req.method==='GET')output=await store.releaseDetail(project,id);
        else if(kind==='releases'&&action==='jobs'&&req.method==='POST')output=await store.createJob(id,body,actor);
        else if(kind==='jobs'&&!action&&req.method==='GET')output=await store.getJob(project,id);
        else if(kind==='jobs'&&action==='acceptance'&&req.method==='POST')output=await store.accept(id,body,actor);
        else if(kind==='jobs'&&action==='stop'&&req.method==='POST')output=await store.stop(id,body,actor);
        else if(kind==='jobs'&&action==='download'&&req.method==='GET'){
          const file=await store.download(project,id,url.searchParams.get('file'));const {start,end,partial}=rangeOf(req.headers.range,file.size);
          const name=String(file.name).replace(/[^A-Za-z0-9._-]/g,'_');
          res.writeHead(partial?206:200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,'content-length':end-start+1,'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff',etag:`"sha256-${file.sha256}"`,...(partial?{'content-range':`bytes ${start}-${end}/${file.size}`}:{})});
          const stream=createReadStream(file.file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
        }else fail('PRODUCTION_NOT_FOUND','入口不存在。',404);
      }
      send(res,200,output);
    }catch(error){if(res.headersSent){res.destroy();return;}const known=error instanceof ProductionDeliveryError;send(res,known?error.status:503,{code:known?error.code:'PRODUCTION_UNAVAILABLE',message:known?error.message:'生产交付服务暂时不可用，请查看服务运行状态。'});}
  });
}

export async function readProductionConfig(filename){
  if(!path.isAbsolute(filename??''))throw new Error('PRODUCTION_CONFIG_PATH_INVALID');const st=await lstat(filename);if(!st.isFile()||st.isSymbolicLink()||st.size>512*1024||(process.platform!=='win32'&&(st.mode&0o077)))throw new Error('PRODUCTION_CONFIG_FILE_INVALID');return JSON.parse(await readFile(filename,'utf8'));
}
async function main(){
  const config=await readProductionConfig(process.env.PRODUCTION_DELIVERY_CONFIG_FILE);const socketPath=config.socketPath;
  if(!path.isAbsolute(socketPath??''))throw new Error('PRODUCTION_SOCKET_INVALID');
  const uid=config.socketUid??process.getuid(),gid=config.socketGid??process.getgid();
  if(!Number.isInteger(uid)||uid<0||!Number.isInteger(gid)||gid<0)throw new Error('PRODUCTION_SOCKET_OWNER_INVALID');
  await mkdir(path.dirname(socketPath),{recursive:true,mode:0o750});
  const parent=await lstat(path.dirname(socketPath));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('PRODUCTION_SOCKET_DIRECTORY_INVALID');
  await chown(path.dirname(socketPath),uid,gid);await chmod(path.dirname(socketPath),0o750);
  let existing;try{existing=await lstat(socketPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing){
    if(!existing.isSocket()||existing.uid!==uid)throw new Error('PRODUCTION_SOCKET_IDENTITY_INVALID');
    const stale=await new Promise(resolve=>{const probe=net.createConnection(socketPath);probe.once('connect',()=>{probe.destroy();resolve(false);});probe.once('error',error=>resolve(error.code==='ECONNREFUSED'));probe.setTimeout(1000,()=>{probe.destroy();resolve(false);});});
    if(!stale)throw new Error('PRODUCTION_SOCKET_IN_USE');await unlink(socketPath);
  }
  const store=new ProductionDeliveryStore(config);await store.initialize();const server=createProductionDeliveryServer({store});
  server.listen(socketPath,async()=>{await chown(socketPath,uid,gid);await chmod(socketPath,0o660);process.stdout.write('PRODUCTION_DELIVERY_LISTENING\n');});
  server.on('error',error=>{process.stderr.write(`PRODUCTION_DELIVERY_START_FAILED:${error.code??'UNKNOWN'}\n`);process.exitCode=1;});
  const stop=()=>server.close(()=>process.exit(0));process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(()=>{process.stderr.write('PRODUCTION_DELIVERY_START_FAILED\n');process.exitCode=1;});
