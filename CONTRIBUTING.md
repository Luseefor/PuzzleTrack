# Contributing

Use Node.js 20 or 22. Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build`. Tests use synthetic observations and local public fixtures; no live service or private dataset is required. Make instrumentation changes explicit in collector/method versions and documentation. Preserve legacy fields and missingness; do not manufacture observations to pass validation.

Never commit browser backups, participant CSVs, imported site histories, generated study allocations, credentials or local analysis artifacts. `data/endgame`, `output`, `fixtures/local` research files and `.env` files are ignored. Commit public synthetic fixtures only. Keep legal reference moves separate from move-quality benchmarks and reported behavior separate from latent cognitive constructs.

Opening/changing a live schedule, adding a rating estimator or reporting a cognitive endpoint requires a reviewed protocol, not just passing code tests. Changes to externally submitted messages/deployments should follow the repository owner's instructions. Use the limited metadata-only ChessTempo bridge only as documented; do not scrape paid puzzles or bypass quotas.
