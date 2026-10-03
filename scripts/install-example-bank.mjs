import {existsSync,mkdirSync,copyFileSync} from 'node:fs';
const destination='data/endgame/bank.json';
if(existsSync(destination))console.log('Existing local bank preserved. No assignments or source data replaced.');
else{mkdirSync('data/endgame',{recursive:true});copyFileSync('examples/public-endgame-bank.json',destination);console.log('Installed frozen public CC0 example bank (5000 positions). Prefix sample, not a representative population.');}
