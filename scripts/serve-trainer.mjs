import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { scheduleStatus, scheduledPool } from './study-schedule.mjs';
import { dailyPool } from './endgame-bank.mjs';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve } from 'node:path';
const root=fileURLToPath(new URL('../extension/dist/',import.meta.url));
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.csv':'text/csv','.txt':'text/plain'};
const dataRoot=process.env.PUZZLETRACK_DATA_DIR?resolve(process.env.PUZZLETRACK_DATA_DIR):fileURLToPath(new URL('../data/endgame/',import.meta.url));
const port=Number(process.env.PUZZLETRACK_PORT??8769);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local server port.');
const bankPath=join(dataRoot,'bank.json');
const configPath=process.env.PUZZLETRACK_CONFIG?resolve(process.env.PUZZLETRACK_CONFIG):fileURLToPath(new URL('../config/study-schedule.json',import.meta.url));
const studyDir=join(dataRoot,'study');
function status(){return scheduleStatus(JSON.parse(readFileSync(configPath,'utf8')));}
function archivedPools(dir){return !existsSync(dir)?[]:readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?archivedPools(join(dir,entry.name)):entry.name.endsWith('.json')?[JSON.parse(readFileSync(join(dir,entry.name),'utf8'))]:[]);}
const dailyDir=join(dataRoot,'daily');
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;
  if(path==='/study-schedule.json') {
    try{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(status()));}
    catch(error){res.writeHead(409,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(error.message);}return;
  }
  if(path==='/study-pool.json') {
    try{
      const current=status(),participant=url.searchParams.get('participant');
      if(!/^[A-Za-z0-9_-]{1,32}$/.test(participant??''))throw new Error('Enter a valid pseudonymous participant ID.');
      if(current.enabled && current.state!=='open'){res.writeHead(403,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('Study access is outside the scheduled window.');return;}
      if(!existsSync(bankPath))throw new Error('A prepared local bank is required; no starter fallback can satisfy scheduled quotas.');
      const assignment=current.enabled?current:{...current,state:'pilot-review',day_index:1,assignment:current.config.days[0]};
      const dir=join(studyDir,current.sha256,current.enabled?current.study_date:'pilot-review');mkdirSync(dir,{recursive:true});
      const file=join(dir,participant+'.json');
      if(!existsSync(file)){
        const previous=[...archivedPools(dailyDir),...archivedPools(studyDir)];
        const pool=scheduledPool(JSON.parse(readFileSync(bankPath,'utf8')),assignment,previous,participant);
        writeFileSync(file,JSON.stringify(pool,null,2)+'\n',{flag:'wx'});
      }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(readFileSync(file));
    }catch(error){res.writeHead(409,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(error.message);}return;
  }
  if(path==='/daily-pool.json') {
    try {
      if(status().enabled){res.writeHead(403,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('Main study mode requires a participant-specific scheduled assignment.');return;}
      if(!existsSync(bankPath)){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(readFileSync(join(root,'pilot-pool.json')));return;}
      mkdirSync(dailyDir,{recursive:true});
      const date=new Date().toISOString().slice(0,10), today=join(dailyDir,date+'.json');
      if(!existsSync(today)) {
        const previous=readdirSync(dailyDir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(dailyDir,f),'utf8')));
        const pool=dailyPool(JSON.parse(readFileSync(bankPath,'utf8')),date,previous);
        writeFileSync(today,JSON.stringify(pool,null,2)+'\n',{flag:'wx'});
      }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(readFileSync(today));
    } catch(error){res.writeHead(409,{'Content-Type':'text/plain'}).end(error.message);}
    return;
  }
  if(['/pilot-pool.json','/pilot-source-rows.csv'].includes(path) && status().enabled){res.writeHead(403,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('Calibration sources are unavailable in main study mode.');return;}
  const file=resolve(join(root,path==='/'?'trainer.html':path.slice(1)));
  if(!file.startsWith(root)){res.writeHead(403).end();return;}
  try {const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'"});res.end(body);}
  catch {res.writeHead(404).end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Endgame trainer: http://localhost:${port} — Ctrl+C to stop. Browser research records stay in this origin; export JSON regularly.`));
