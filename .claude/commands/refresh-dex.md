---
description: Re-bake the full Pokedex from PokeAPI and verify the result
---

1. Run `npm run refresh-dex`. It takes 5-10 minutes and hits PokéAPI ~2600
   times at a concurrency of 8. Do not raise the concurrency.
2. Confirm `src/data/pokedex.json` and `src/data/moves.json` were written.
3. Sanity-check the output before committing:
   - pokedex.json has roughly 1300+ entries
   - Pikachu (id 25) has base stats 35/55/40/50/50/90
   - moves.json contains no entries where `power` is null
4. Run `npm run test:run && npm run build`.
5. Commit both JSON files. They are meant to be in version control — the app
   must never call PokéAPI at runtime.
