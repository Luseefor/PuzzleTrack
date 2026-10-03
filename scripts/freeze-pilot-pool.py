"""Freeze a bounded, explicitly selected CC0 pilot subset from a local zstd prefix.
Usage: python3 scripts/freeze-pilot-pool.py INPUT.zst [COUNT]
The prefix may end mid-frame; only complete CSV rows emitted before truncation are used.
This selection is for calibration, not a representative research population.
"""
import csv, hashlib, io, json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
source = Path(sys.argv[1]); count = int(sys.argv[2]) if len(sys.argv) > 2 else 200
process = subprocess.Popen(['zstd', '-dc', str(source)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
reader = csv.DictReader(io.TextIOWrapper(process.stdout, encoding='utf-8'))
rows = []
for row in reader:
    if None in row or any(value is None for value in row.values()): continue
    try:
        eligible = ('endgame' in row['Themes'].split() and 400 <= int(row['Rating']) <= 2600
          and int(row['RatingDeviation']) <= 100 and int(row['NbPlays']) >= 100 and int(row['Popularity']) >= 0)
    except (KeyError, ValueError): continue
    if eligible: rows.append(row)
    if len(rows) >= count: break
process.terminate(); process.wait()
if len(rows) != count: raise SystemExit(f'Only {len(rows)} eligible rows; provide a larger prefix.')
folder = Path('extension/assets'); folder.mkdir(exist_ok=True)
raw = folder/'pilot-source-rows.csv'
with raw.open('w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
pool = {'format':'puzzletrack-local-pool', 'version':1, 'source':{
 'url':'https://database.lichess.org/lichess_db_puzzle.csv.zst', 'license':'CC0-1.0',
 'retrieved_at':datetime.now(timezone.utc).isoformat(),
 'selection':'First '+str(count)+' complete eligible rows in downloaded prefix; endgame theme; rating 400–2600; RD <=100; plays >=100; popularity >=0. Calibration pool, not a representative sample.',
 'compressed_prefix_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
 'raw_rows_sha256':hashlib.sha256(raw.read_bytes()).hexdigest()}, 'puzzles': rows}
(folder/'pilot-pool.json').write_text(json.dumps(pool, indent=2)+'\n')
print(f'Frozen {len(rows)} CC0 endgame-themed first-move pilot positions.')
