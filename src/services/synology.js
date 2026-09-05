import { spawn } from 'node:child_process';
import readline from 'node:readline';

let worker=null, sequence=0, stderrTail='';
const pending=new Map();
const python=()=>process.env.PYRUIJIE_PYTHON||'/opt/pyruijie/bin/python';

function startWorker(){
  if(worker&&!worker.killed)return worker;
  worker=spawn(python(),['-u',new URL('./synology_worker.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  const lines=readline.createInterface({input:worker.stdout});
  lines.on('line',line=>{try{const msg=JSON.parse(line),item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);msg.ok?item.resolve(msg.result):item.reject(new Error(msg.error||'Synology API request failed'));}catch{}});
  worker.stderr.on('data',chunk=>{const t=String(chunk);stderrTail=(stderrTail+t).slice(-6000);console.error(`[synology-api] ${t.trim()}`);});
  worker.on('exit',code=>{const detail=stderrTail.trim().split(/\r?\n/).slice(-4).join(' | ');const err=new Error(`synology-api worker exited (${code??'unknown'})${detail?`: ${detail}`:''}`);for(const item of pending.values()){clearTimeout(item.timer);item.reject(err);}pending.clear();worker=null;stderrTail='';});
  return worker;
}
function cfg(service){
  const c=service.credentials||{};
  return {host:service.host,port:service.port||((service.scheme||'https')==='https'?5001:5000),secure:(service.scheme||'https')==='https',insecureTls:Boolean(service.insecureTls),username:c.synologyUsername||c.username||'',password:c.synologyPassword||c.password||'',otpCode:c.synologyOtpCode||'',dsmVersion:Number(c.synologyDsmVersion||7)};
}
function call(service,action='collect',timeout=45000){return new Promise((resolve,reject)=>{const proc=startWorker(),id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Synology DSM API request timed out'));},timeout);pending.set(id,{resolve,reject,timer});proc.stdin.write(`${JSON.stringify({id,action,config:cfg(service)})}\n`,err=>{if(err){clearTimeout(timer);pending.delete(id);reject(err);}});});}
function data(result){return result?.ok===false?null:(result?.data??result??null);}
function objects(root,out=[]){if(root==null)return out;if(typeof root!=='object')return out;if(Array.isArray(root)){for(const v of root)objects(v,out);return out;}out.push(root);for(const v of Object.values(root))if(v&&typeof v==='object')objects(v,out);return out;}
function value(root,keys){
  const wanted=keys.map(x=>x.toLowerCase());
  if(['string','number','boolean'].includes(typeof root)) return root;
  for(const o of objects(root)){for(const [k,v] of Object.entries(o)){if(wanted.includes(String(k).toLowerCase())&&['string','number','boolean'].includes(typeof v))return v;}}
  return null;
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function arrays(root,out=[]){if(!root||typeof root!=='object')return out;if(Array.isArray(root)){out.push(root);for(const v of root)arrays(v,out);return out;}for(const v of Object.values(root))arrays(v,out);return out;}
function arrayByKeys(root,keys){
  for(const o of objects(root)){for(const k of keys){const v=o?.[k];if(Array.isArray(v))return v;}}
  return arrays(root).sort((a,b)=>b.length-a.length)[0]||[];
}
function normVolumes(raw){
  const r=data(raw);return arrayByKeys(r,['volumes','volume','items','shares']).filter(v=>v&&typeof v==='object').map((v,i)=>({id:v.id||v.volume_id||v.name||v.volume_path||`volume-${i+1}`,name:v.name||v.id||v.volume_path||v.path||`Volume ${i+1}`,status:v.status||v.health||v.state||'',fsType:v.fs_type||v.filesystem||v.fsType||'',size:n(v.size_total??v.total_size??v.total??v.size),used:n(v.size_used??v.used_size??v.used),free:n(v.size_free??v.free_size??v.free)}));
}
function normDisks(raw){
  const r=data(raw);return arrayByKeys(r,['disks','disk','items']).filter(d=>d&&typeof d==='object'&&(d.model||d.serial||d.serial_number||d.name||d.id||d.disk_id)).map((d,i)=>({id:d.id||d.name||d.disk_id||d.device||`disk-${i+1}`,name:d.name||d.id||d.disk_id||d.device||d.model||`Disk ${i+1}`,model:d.model||d.model_name||'',vendor:d.vendor||'',serial:d.serial||d.serial_number||'',status:d.status||d.health||d.state||'',temperature:n(d.temp??d.temperature),size:n(d.size_total??d.total_size??d.size)}));
}
function normPackages(raw){
  const r=data(raw);return arrayByKeys(r,['packages','package','items']).filter(x=>x&&typeof x==='object'&&(x.package||x.name||x.id)).map((x,i)=>({id:x.id||x.package||x.name||`package-${i+1}`,name:x.name||x.package||x.id||`Package ${i+1}`,version:x.version||'',status:x.status||x.additional?.status||x.running||'',description:x.description||''}));
}
function normalized(snapshot={}){
  const sys=data(snapshot.system)||{}, util=data(snapshot.utilization)||{}, stat=data(snapshot.status)||{}, healthData=data(snapshot.health)||{};
  const volumes=normVolumes(snapshot.volumes),disks=normDisks(snapshot.disks),packages=normPackages(snapshot.packages);
  const model=value(sys,['model','model_name','product_model'])||'';
  const version=value(sys,['firmware_ver','version_string','version','dsm_version'])||'';
  const serial=value(sys,['serial','serial_number'])||'';
  let cpu=n(value(util,['total_load','cpu_usage','usage','utilization','user_load']));if(cpu!=null&&cpu<=1)cpu*=100;
  let memTotal=n(value(util,['total_real','memory_size','memory_total','total']));let memUsed=n(value(util,['used_real','memory_used','used']));let memPct=n(value(util,['real_usage','memory_usage','usage_percent']));if(memPct!=null&&memPct<=1)memPct*=100;if(memUsed==null&&memTotal&&memPct!=null)memUsed=memTotal*memPct/100;
  const temp=n(value(data(snapshot.temperature),['temperature','temp','cpu_temp']) ?? value(stat,['temperature','cpu_temperature','system_temp']));
  const uptime=n(value(sys,['up_time','uptime','uptime_sec']));
  const healthy=value(healthData,['healthy','health','status']) ?? value(stat,['healthy','health','status']) ?? 'unknown';
  const status=snapshot.system?.ok===false?0:1;
  return {serviceType:'synology',status,running:status===1,version:String(version||''),model:String(model||''),serial:String(serial||''),cpu,memoryUsed:memUsed,memoryTotal:memTotal,memoryPercent:memPct,temperature:temp,uptimeSec:uptime,health:healthy,volumeCount:volumes.length,diskCount:disks.length,packageCount:packages.length,volumes,disks,packages,rawStatusErrors:Object.fromEntries(Object.entries(snapshot).filter(([,v])=>v?.ok===false).map(([k,v])=>[k,v.error]))};
}
export async function collectSynology(service){return normalized(await call(service,'collect'));}
export async function testSynology(service){const started=performance.now();const result=await call(service,'test');const sys=data(result.system);if(!sys)throw new Error(result.system?.error||'Synology API did not return system information');return {ok:true,latencyMs:Math.round((performance.now()-started)*10)/10,model:String(value(sys,['model','model_name'])||''),version:String(value(sys,['firmware_ver','version_string','version'])||'')};}
export async function getSynologyStorage(service){const r=await call(service,'storage');return {volumes:normVolumes(r.volumes),disks:normDisks(r.disks),errors:Object.fromEntries(Object.entries(r).filter(([,v])=>v?.ok===false).map(([k,v])=>[k,v.error]))};}
export async function getSynologyPackages(service){const r=await call(service,'packages');return {packages:normPackages(r.packages),error:r.packages?.ok===false?r.packages.error:null};}
export async function controlSynology(service,action){if(!['reboot','shutdown'].includes(action))throw new Error('Unsupported Synology action');return {ok:true,action,...await call(service,action)};}
