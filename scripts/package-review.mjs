// Run npm run build, start the local trainer, then npm run review:package.
import { cpSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
const participant=process.argv[2]??'PROF_REVIEW';
if(!/^[A-Za-z0-9_-]{1,32}$/.test(participant))throw new Error('Invalid review ID.');
const config=JSON.parse(readFileSync('config/study-schedule.json','utf8'));
if(config.enabled)throw new Error('Create a review package only from the disabled pilot configuration.');
const response=await fetch(`http://127.0.0.1:8769/study-pool.json?participant=${encodeURIComponent(participant)}`);
if(!response.ok)throw new Error(await response.text());
const raw=await response.text(),pool=JSON.parse(raw);
const parent=resolve('output/professor-review'),root=join(parent,'PuzzleTrack-professor-review');
rmSync(root,{recursive:true,force:true});mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'extension/dist'),{recursive:true});mkdirSync(join(root,'config'),{recursive:true});mkdirSync(join(root,'data/endgame/study',pool.source.schedule_sha256,'pilot-review'),{recursive:true});mkdirSync(join(root,'docs'),{recursive:true});
for(const file of ['trainer.html','trainer.css','trainer.js','analyze-dataset.mjs','CHESS_JS_LICENSE.txt'])cpSync(join('extension/dist',file),join(root,'extension/dist',file));
cpSync('LICENSE',join(root,'LICENSE'));cpSync('THIRD_PARTY_NOTICES.md',join(root,'THIRD_PARTY_NOTICES.md'));
cpSync('config/study-schedule.json',join(root,'config/study-schedule.json'));
cpSync('data/endgame/bank.json',join(root,'data/endgame/bank.json'));
writeFileSync(join(root,'data/endgame/study',pool.source.schedule_sha256,'pilot-review',participant+'.json'),raw);
for(const file of ['PROFESSOR_REVIEW.md','DAILY_STUDY_SCHEDULE.md','MEASUREMENT_AUDIT.md','TABLEBASE_ANALYSIS.md'])cpSync(join('docs',file),join(root,'docs',file));
const benchmarkFile=join(parent,'professor-benchmarks.json');
if(participant==='PROF_REVIEW' && existsSync(benchmarkFile)){
  const benchmark=JSON.parse(readFileSync(benchmarkFile,'utf8'));
  const {createHash}=await import('node:crypto');
  if(benchmark.pool_sha256!==createHash('sha256').update(raw).digest('hex'))throw new Error('Professor benchmark does not match frozen pool.');
  mkdirSync(join(root,'benchmarks'),{recursive:true});cpSync(benchmarkFile,join(root,'benchmarks/professor-benchmarks.json'));
}
writeFileSync(join(root,'README.txt'),`PuzzleTrack professor-review pilot 0.6.0\n\nRequires Node.js 20+ and a modern desktop browser. No npm install needed.\nFrom this directory run: node scripts/serve-trainer.mjs\nThen open: http://localhost:8769/?participant=${participant}\n\nRead docs/PROFESSOR_REVIEW.md before playing. Study hours are disabled.\nEach assignment has 10 puzzles, 5 easy + 5 hard, 15 minutes each.\nNo responses or browser storage from the researcher are included.\nOther IDs create independent pilot assignments on this copy. Allocations/records do not synchronize between copies.\nKeep one assigned ID per real participant. Export CSV and JSON after review.\n\nCC0 puzzle source: https://database.lichess.org/#puzzles\nSee data/endgame/bank.json for exact provenance. Bank is a prefix sample.\nMove legality: chess.js 1.4.0; license in extension/dist/CHESS_JS_LICENSE.txt.\nThis prototype does not directly measure cognition. An archived first-position WDL sidecar is included when prepared; see docs/TABLEBASE_ANALYSIS.md. No within-class move-quality metric or calibrated skill rating is supplied.\n`);
buildSync({entryPoints:['scripts/serve-trainer.mjs'],outfile:join(root,'scripts/serve-trainer.mjs'),bundle:true,format:'esm',platform:'node',target:'node20',logLevel:'warning'});
const zip=join(parent,'PuzzleTrack-professor-review.zip');rmSync(zip,{force:true});
execFileSync('zip',['-qr',zip,'PuzzleTrack-professor-review'],{cwd:parent});
console.log(`Review package: ${zip}\nParticipant: ${participant}; batch code ${pool.source.batch_code}; no email sent.`);
