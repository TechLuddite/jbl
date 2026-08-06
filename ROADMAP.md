# Roadmap

Ordered roughly by value-per-hour. Nothing here is committed to.

## Known v1 limitations

These are deliberate, not bugs. Don't let an agent "fix" them by surprise.

**League data is single-device.** It lives in `localStorage`, so the standings
exist in one browser on one machine. Export/import JSON is the stopgap. Making
the whole family able to log battles from their own phones needs a real backend
and is the single biggest remaining piece of work.

**The calculator ignores held items, abilities, weather, stat stages and
screens.** The modifier chain in `battle.js` has an `other` parameter ready for
them; nothing feeds it yet. The sim does feed it — the calculator tab simply
hasn't been given the controls.

**One tourney format.** The league has a single-elimination knockout tourney
(added 2026-08: each trainer fights with one league Pokémon at level 50, with
manual/auto matches and an optional pass-the-device secret pick round). There's
still no round-robin, no badge tracking, no season concept.

## In progress: the battle sim

Decided 2026-08. U-pick battle sim: two teams of 1–6 Pokémon, played out
turn by turn. Agreed scope, in landing order:

1. **Data.** Bake learnsets (latest version group per Pokémon), ability slugs,
   and the full move list — status moves included — with accuracy, PP,
   priority, and effect metadata. The script is ready; the bake itself still
   needs to run somewhere that can reach pokeapi.co (`npm run refresh-dex`,
   then commit the JSON). Until then the app runs on the 52-entry sample set,
   where every move is legal and nothing ever misses (no accuracy data).
2. **Engine core** (`src/lib/sim.js`, tested like `battle.js`): speed and
   priority order, accuracy and misses, crits, PP, the five status conditions,
   stat stages, faint-and-switch. Seeded RNG so tests are exact.
3. **Battle tab UI.** Team picker (learnset-legal moves when the full dex is
   present; free pick on the sample set), hotseat turn-by-turn play with the
   working shown every turn, plus an auto-battle mode where the sim picks
   moves.
4. **Kitchen-sink expansion, staged:** weather, entry hazards, held items,
   abilities. Items and abilities land as a curated set of the common ones
   first and grow from there — correctness over coverage. (Grown a long way
   in 2026-08; see 6 below.)
5. **Anything that spans more than one turn** (added 2026-08, after Joseph
   pointed out the sim fired Solar Beam instantly and never locked Outrage in):
   two-turn charge moves with semi-invulnerability, Power Herb, recharge moves,
   rampage locks, confusion, momentum moves, partial trapping and the switch
   block it applies, Leech Seed, Wish, Future Sight, Perish Song, Yawn, Taunt,
   Encore, Disable, the screens, Tailwind, Trick Room, Protect, Substitute,
   Fake Out, Focus Punch, Roost's grounding and the switch-out moves.

6. **The item and ability sets, properly** (added 2026-08, after Joseph
   pointed out that most Pokémon had an ability the sim had never heard of).
   25 abilities became ~130 and 11 items became ~75, all under the same rule:
   modeled and hand-tested, or not offered. The unlock was move flags —
   PokéAPI doesn't publish them, so `npm run refresh-flags` bakes them from a
   second source into `src/data/move-flags.json`, the same way the dex is
   baked. That gave the sim a contact flag and with it Static, Rough Skin,
   Rocky Helmet, Tough Claws and the punish riders on Spiky Shield and
   King's Shield.

### Still not modeled in the sim

Deliberate gaps, in rough order of how much they'd be missed:

- **The abilities that change what a Pokémon IS** — Illusion, Disguise, Ice
  Face, Zen Mode, Imposter, Protean, Stance Change, Multitype. Each needs the
  engine to swap types or forms mid-battle, which nothing else does yet.
- **Magic Bounce and Magic Coat** — bouncing a status move back needs the
  move to be re-run from the other side, which the move loop can't do.
- **The absorbing abilities only read attacks.** Volt Absorb, Lightning Rod,
  Storm Drain and Sap Sipper all sit in the damaging-move path, so an Electric
  STATUS move — Thunder Wave — still lands on a Lightning Rod Pokémon. In the
  real games it wouldn't.
- **Trace, Forecast, Download's cousins** — abilities that copy or react to
  another ability.
- **Doubles-only abilities** are listed but marked as doing nothing, which is
  correct for a one-on-one battle and would need doubles to be worth more.
- **Terrain** (Electric, Grassy, Misty, Psychic) — and with it Protosynthesis,
  Quark Drive and the four surge abilities.
- **Bide, infatuation, Torment, Imprison, Magic Coat, Baton Pass** and the
  other one-off status moves — 128 of the 277 status moves still say "not in
  the sim yet" in the log rather than pretending to work.
- **Switch-out timing.** U-turn, Volt Switch and Flip Turn ask for the swap,
  but the replacement arrives at the end of the turn instead of instantly, so
  end-of-turn chip damage still lands on the Pokémon that left.
- **Future Sight** ignores screens, items and crits when it lands.

Sim battles can optionally be recorded in the league — the app asks after the
battle ends; nothing is logged automatically.

## Next up

- [ ] **Badge tracking in the league.** Eight badges, earned by beating the
      matching Gym Leader. Pairs with physical printed badges.
- [ ] **Team builder.** Save a six-Pokémon team, see combined type coverage and
      shared weaknesses. Natural bridge between the calc and stat tabs.
      (The sim's team picker is the natural seed for this.)

## Later

- [ ] **Multi-device league.** Options, cheapest first:
      - A gist or GitHub repo as a JSON store, written via a PAT. Free, ugly,
        works. Fine for a family.
      - Supabase free tier. Proper auth, ~an evening of work.
      - Cloudflare Workers + KV. Also free, more control.
      Weigh this against just running the league off one shared tablet.
- [ ] **Speed tiers.** Who outspeeds whom at a given level, sortable. Very
      popular with competitive players.
- [ ] **Type coverage checker.** Given four moves, which of the 18 types can you
      not hit for neutral damage.
- [ ] **PWA / offline install.** Add to home screen on a phone. The dataset is
      already static so this is mostly a manifest and a service worker.
- [ ] **Fakémon designer.** Invent a Pokémon within a stat budget, see where it
      would land on the leaderboards.

## Explicitly not doing

- Live PokéAPI calls at runtime. Ever.
- Accounts, logins, or anything collecting personal data. It's a family app for
  a child.
- Monetisation of any kind. Keeping this non-commercial is what keeps a fan
  project uncontroversial.
