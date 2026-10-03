import {existsSync,mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const destination='data/endgame/bank.json';
if(existsSync(destination))console.log('Existing local bank preserved. No source bank replaced.');
else{mkdirSync('data/endgame',{recursive:true});copyFileSync('examples/public-endgame-bank.json',destination);console.log('Installed frozen public CC0 example bank (5000 positions). Prefix sample, not a representative population.');}
// Seed only the explicitly public, unplayed professor fixture, never another participant's records.
const poolFile='examples/professor-review/pool.json',pool=JSON.parse(readFileSync(poolFile,'utf8'));
const config=JSON.parse(readFileSync('config/study-schedule.json','utf8'));
const hash=createHash('sha256').update(JSON.stringify(config)).digest('hex');
if(!config.enabled && pool.source.schedule_sha256===hash){
 const dir=join('data/endgame/study',hash,'pilot-review'),file=join(dir,'PROF_REVIEW.json');
 if(!existsSync(file)){mkdirSync(dir,{recursive:true});copyFileSync(poolFile,file);console.log('Installed exact public PROF_REVIEW source fixture; no observations added.');}
 else console.log('Existing professor assignment preserved.');
}
