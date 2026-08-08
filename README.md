# Joseph's Battle Lab

A Pokémon damage calculator, battle sim, Pokédex, stat explorer, and family
league tracker.

**Live: https://jbl.opsvibe.systems**

The calculator shows its working — every step from base stats to the sixteen
possible damage rolls — because the point is to make the maths visible, not to
hide it behind a number.

## Quick start

```bash
npm install
npm run dev
```

Runs on the bundled 52-Pokémon sample set. For the full dex:

```bash
npm run refresh-dex       # ~5-10 min, writes src/data/pokedex.json + moves.json
npm run refresh-species   # ~5-10 min, the Pokédex tab's bios, sizes, evolutions
```

Commit the generated JSON. The app never calls PokéAPI at runtime.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run test` | Vitest in watch mode |
| `npm run test:run` | Single test run (what CI uses) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the built output locally |
| `npm run refresh-dex` | Re-bake the full dex from PokéAPI |
| `npm run refresh-species` | Re-bake the Pokédex details (bios, sizes, evolutions, abilities) |

## Deploying

Pushes to `main` build, test, and publish to GitHub Pages automatically.

**One-time setup:**

1. **Repo → Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Not "Deploy from a branch". The workflow won't publish otherwise.
2. **DNS at your registrar for `opsvibe.systems`** — add a CNAME record:

   ```
   jbl   CNAME   techluddite.github.io.
   ```

   (Host `jbl`, target `techluddite.github.io`, note the trailing dot if your
   provider wants one. Do *not* point it at the repo name.)
3. **Repo → Settings → Pages → Custom domain:** enter `jbl.opsvibe.systems`,
   save, then tick **Enforce HTTPS** once the certificate is issued. That can
   take up to an hour on first setup.

`public/CNAME` keeps the custom domain from being wiped on each deploy. The
workflow fails the build if it goes missing.

## Project layout

```
src/lib/       battle math (tested), sim engine, type chart, natures, storage
src/data/      dex data — sample set committed, full set generated
src/features/  DamageCalc, BattleSim, League, StatDex, Dex, News, Report
scripts/       build-*.mjs — PokéAPI → static JSON, run by hand
```

`src/lib/battle.js` is the reference implementation for all game maths and is
covered by 20 tests. See `CLAUDE.md` before changing it.

## Notes

Fan project, non-commercial, not affiliated with Nintendo, Game Freak, Creatures
Inc. or The Pokémon Company. Pokémon data via [PokéAPI](https://pokeapi.co),
sprites via the [PokeAPI/sprites](https://github.com/PokeAPI/sprites) repo.
