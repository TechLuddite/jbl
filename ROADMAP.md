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
them; nothing feeds it yet.

**No bracket structure.** Battles are logged flat. There's no tournament tree,
no badge tracking, no season concept.

## Next up

- [ ] **Held items and abilities in the calculator.** Biggest accuracy win.
      Needs a new data field on dex entries, so re-bake required.
- [ ] **Stat stages (+1 through +6).** Easy, high perceived value.
- [ ] **Badge tracking in the league.** Eight badges, earned by beating the
      matching Gym Leader. Pairs with physical printed badges.
- [ ] **Team builder.** Save a six-Pokémon team, see combined type coverage and
      shared weaknesses. Natural bridge between the calc and stat tabs.

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
