# Third-party data and software

- **chess.js 1.4.0**: BSD-2-Clause. The production build/review package copies its full license into `extension/dist/CHESS_JS_LICENSE.txt`. See https://github.com/jhlywa/chess.js.
- **Lichess puzzle database**: CC0-1.0, https://database.lichess.org/#puzzles. Bundled starter positions and generated local banks retain original source fields and provenance. The prepared bank is a download-prefix sample, not a representative population. Public puzzle/game URLs are source attribution, not participant identity data.
- **Archived tablebase responses**: factual endgame probes from https://tablebase.lichess.ovh/, with exact request FEN/URL, retrieval timestamp and raw-response SHA-256. No tablebase service software is redistributed. API documentation: https://github.com/lichess-org/lila-tablebase#http-api.
- Development dependencies retain their own licenses in npm packages. `package-lock.json` pins their resolved versions.

PuzzleTrack's original code is all rights reserved under LICENSE; public availability is not a license grant. This does not change the CC0 status of source puzzle data or the included dependency licenses. Do not include private participant observations or site credentials when sharing source or release packages.
