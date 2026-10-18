import http from 'node:http';
import path from 'node:path';

const PREFIX='/forge-gateway/api/production/';
export function createProductionDeliveryClient({socketPath,timeoutMs=20000}) {
  if(!path.isAbsolute(socketPath??''))throw new Error('PRODUCTION_SOCKET_INVALID');
  function call({method='GET',path:requestPath,body,actor,range},download=false) {
    if(!requestPath.startsWith(PREFIX))throw new Error('PRODUCTION_PATH_INVALID');
    const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject)=>{
      const headers={'content-type':'application/json'};if(bytes)headers['content-length']=bytes.length;
      if(actor)headers['x-production-actor']=Buffer.from(JSON.stringify(actor)).toString('base64url');if(range)headers.range=range;
      const req=http.request({socketPath,path:requestPath,method,headers},res=>{
        if(download&&[200,206].includes(res.statusCode)){resolve({status:res.statusCode,headers:res.headers,stream:res});return;}
        let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)req.destroy(new Error('PRODUCTION_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks));if(res.statusCode>=400)reject(Object.assign(new Error(result.message??'生产交付请求失败。'),{code:result.code,status:res.statusCode}));else resolve(result);}catch(error){reject(error);}});
      });
      req.setTimeout(timeoutMs,()=>req.destroy(Object.assign(new Error('生产交付服务响应超时。'),{code:'PRODUCTION_TIMEOUT',status:503})));
      req.on('error',reject);req.end(bytes);
    });
  }
  return {request:input=>call(input),download:input=>call({...input,method:'GET'},true)};
}
