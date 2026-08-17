/**
 * What's new, written for the person who uses this app — not for a developer.
 *
 * Rules for adding an entry:
 *   - Newest first. The top entry's date doubles as the app's version, and it
 *     is what the Report tab sends along with a bug report, so keep it current.
 *   - Plain verbs, no jargon, sentence case. "Solar Beam charges up for a
 *     turn", not "implemented two-turn charge move semantics".
 *   - Say what it means in a battle, not what changed in the code.
 *   - `credit` is for when someone spotted it. Use it — being named in the
 *     changelog is the best part of reporting something. But only when you
 *     actually know whose it was: leave it off rather than guess. The people
 *     reading this remember exactly what they did and didn't suggest, and a
 *     credit on the wrong entry sours the ones that are right.
 *
 * `kind` is "new" for things that weren't there before and "fix" for things
 * that were wrong.
 */

export const CHANGELOG = [
  {
    date: "2026-08-17",
    title: "The Pokédex arrows stay put",
    credit: "Spotted by Joseph",
    intro:
      "The ◀ and ▶ arrows on the Pokédex used to jump sideways every time you " +
      "pressed one, because the name box next to them changed width with the " +
      "name. They've moved to the left of the name box, so now they stay still.",
    changes: [
      { kind: "fix", text: "The ◀ and ▶ arrows on the Pokédex don't move any more. Going from Mew to Charizard used to slide them along, so the arrow was never quite where you left your finger. You can hold your place and tap through the whole dex now." },
    ],
  },
  {
    date: "2026-08-08",
    title: "A proper Pokédex",
    credit: "Suggested by Joseph",
    intro:
      "There's a new tab. Pick any Pokémon and you get the big painted picture, " +
      "its Pokédex entry straight out of the games, how tall and heavy it is, " +
      "what it evolves into, what beats it, and every move it can learn.",
    changes: [
      { kind: "new", text: "The Pokédex tab. One Pokémon at a time, with a proper picture instead of the little battle sprite." },
      { kind: "new", text: "The bio is the real Pokédex entry from the games, and it says underneath which game it's quoted from. Nothing on the page is made up about a Pokémon." },
      { kind: "new", text: "Height, weight, how likely it is to be male or female, how hard it is to catch, its egg groups and how long its egg takes to hatch." },
      { kind: "new", text: "Every ability it can have, with what the ability actually does. If the Battle tab doesn't know that ability yet, it says so instead of pretending." },
      { kind: "new", text: "Its whole evolution line and what it takes to get there — a level, a stone, a trade. Tap any stage to jump to it." },
      { kind: "new", text: "What it takes more damage from and what it shrugs off, worked out from its types, with 4× and ¼× shown properly." },
      { kind: "new", text: "Every move it can learn. Switch between the order it learns them as it levels up and the whole list, and search inside it." },
      { kind: "new", text: "On the Stats tab there's a little arrow next to every name. Press it and you land on that Pokémon's full Pokédex page." },
      { kind: "fix", text: "Gen 1 Pokémon had forgotten everything they'd learned since 1996. Mewtwo could only pick from 43 moves and Bulbasaur from 23 — Mewtwo now has 102 and Bulbasaur 48. It affected 187 Pokémon, and it was making the Battle tab much duller than it should have been." },
      { kind: "fix", text: "Move lists now all come from Scarlet and Violet. A few Pokémon — Machamp, Lopunny, Aggron — had been picking their moves up from a battle-only spin-off instead, so they've lost some options they wouldn't really have. What's left is what they can actually learn in the game." },
    ],
  },
  {
    date: "2026-08-06",
    title: "Abilities and items, properly this time",
    credit: "Spotted by Joseph",
    intro:
      "Most Pokémon had an ability the sim had never heard of, and there were " +
      "only eleven items to choose from. Now there are over a hundred abilities " +
      "and more than seventy items, and every one of them actually does " +
      "something in a battle.",
    changes: [
      { kind: "new", text: "Static, Flame Body, Poison Point, Rough Skin, Iron Barbs and Effect Spore all work now. Touch a Pikachu and you might come away paralysed." },
      { kind: "new", text: "Rocky Helmet hurts anything that touches its holder, and Spiky Shield, King's Shield and Baneful Bunker finally punish whatever hits them instead of just blocking it." },
      { kind: "new", text: "Swift Swim, Chlorophyll, Sand Rush and Slush Rush double your Speed in the right weather. Sand Veil and Snow Cloak make you harder to hit." },
      { kind: "new", text: "Sheer Force, Tinted Lens, Iron Fist, Strong Jaw, Tough Claws, Sharpness, Analytic, Sniper, Serene Grace, Skill Link, Hustle and Technician's other relatives all change how hard you hit." },
      { kind: "new", text: "Solid Rock, Filter, Multiscale, Fur Coat, Ice Scales, Heatproof and Fluffy all change how hard you get hit." },
      { kind: "new", text: "Lightning Rod, Storm Drain, Motor Drive, Sap Sipper, Earth Eater and Well-Baked Body swallow a whole type of move and give you a boost for it. Soundproof and Bulletproof just refuse." },
      { kind: "new", text: "Moxie, Beast Boost, Defiant, Competitive, Weak Armor, Steadfast, Anger Point, Justified, Rattled, Stamina and Berserk all react to what just happened to you." },
      { kind: "new", text: "Prankster sends status moves first — unless the other Pokémon is a Dark type, which ignores them completely. Gale Wings, Triage and Stall change the order too." },
      { kind: "new", text: "Clear Body, Hyper Cutter, Big Pecks and Keen Eye stop the other side lowering your stats. Contrary turns every stat change upside down and Simple doubles it." },
      { kind: "new", text: "Mold Breaker walks straight through Levitate, Sturdy and anything else in its way. Wonder Guard only lets super effective moves through." },
      { kind: "new", text: "There's a boosting item for all eighteen types — Charcoal, Magnet, Mystic Water and the rest — and a berry that halves one super effective hit of each type." },
      { kind: "new", text: "Rocky Helmet, Heavy-Duty Boots, Weakness Policy, Safety Goggles, Light Clay, Quick Claw, Flame Orb, Toxic Orb, Black Sludge, Lum Berry, Shell Bell, Scope Lens, King's Rock, Bright Powder, White Herb, Mental Herb, Metronome and the four weather rocks are all in." },
      { kind: "new", text: "The held item and ability menus now have a search box at the top, like the Pokémon and move menus. Type what you want instead of scrolling — and you can search what an item does, so typing \"burn\" finds the Flame Orb." },
      { kind: "new", text: "Every item and ability in the menus says what it does right next to its name." },
      { kind: "new", text: "Abilities like Pickup and Run Away are listed honestly as doing nothing in a one-on-one battle, rather than looking broken." },
    ],
  },
  {
    date: "2026-08-04",
    title: "This page, and a way to report things",
    changes: [
      { kind: "new", text: "The What's new tab you're reading. Every update to the lab gets written up here, in words that actually say what changed in a battle. There's a dot on the tab when there's something you haven't read." },
      { kind: "new", text: "The Report tab. Found a move that doesn't work like the real game? Write it down and press send — it opens GitHub with your report already filled in. Pick the move it's about and it gets filed under that name." },
      { kind: "new", text: "If the send button asks you to log in, there's a copy button instead, so you can hand the report to someone else to send." },
    ],
  },
  {
    date: "2026-08-04",
    title: "Moves that take their time",
    credit: "Spotted by Joseph",
    intro:
      "Loads of moves don't happen all at once — they charge up, lock you in, " +
      "or tick away in the background. None of that was in the sim. Now it is.",
    changes: [
      { kind: "new", text: "Solar Beam charges up for a turn, then fires. In bright sunshine it fires straight away — and in rain it only hits half as hard." },
      { kind: "new", text: "Fly, Dig, Dive and Phantom Force hide you for a turn, and most moves can't reach you. But Earthquake finds you underground, and it hits twice as hard for catching you there." },
      { kind: "new", text: "Hyper Beam and Giga Impact are so big you have to spend the next turn getting your breath back." },
      { kind: "new", text: "Outrage, Thrash and Petal Dance lock you in for two or three turns and leave you confused at the end." },
      { kind: "new", text: "Being confused means a one-in-three chance of hitting yourself instead of attacking." },
      { kind: "new", text: "Fire Spin, Bind and Whirlpool squeeze you every turn and won't let you swap out." },
      { kind: "new", text: "Leech Seed, Wish, Future Sight, Perish Song and Yawn all keep counting in the background until they go off." },
      { kind: "new", text: "Taunt, Encore and Disable each take a move away from you in a different way." },
      { kind: "new", text: "Reflect and Light Screen halve damage for five turns. Tailwind doubles your Speed. Trick Room makes the slowest Pokémon go first." },
      { kind: "new", text: "Protect blocks the whole attack — but use it twice in a row and it will probably fail. Shadow Force goes straight through it anyway." },
      { kind: "new", text: "Substitute puts up a doll that takes the hits, and blocks status moves while it stands." },
      { kind: "new", text: "Fake Out only works the turn you come in. Focus Punch breaks if you get hit first. Roost costs a Flying type its wings until the end of the turn." },
      { kind: "new", text: "Rollout and Fury Cutter get stronger every time you use them in a row." },
      { kind: "new", text: "Power Herb lets you skip a charge turn, once." },
      { kind: "fix", text: "Power-Up Punch was raising the wrong Pokémon's Attack — it was making your opponent stronger! Meteor Mash, Metal Claw and Flame Charge were doing the same thing." },
      { kind: "fix", text: "Draco Meteor now lowers your own Special Attack even when it knocks the other Pokémon out." },
      { kind: "fix", text: "Make It Rain and Armor Cannon weren't lowering anything at all. Now they do." },
      { kind: "fix", text: "Encore, Yawn and Perish Song work on Ghost types now, and Confuse Ray works on Normal types. The type chart only stops attacks, not status moves." },
    ],
  },
  {
    date: "2026-08-03",
    title: "Search every move list",
    changes: [
      { kind: "new", text: "Every move and Pokémon dropdown has a search box. Start typing a name and it finds it — no more scrolling past a thousand Pokémon." },
    ],
  },
  {
    date: "2026-08-03",
    title: "League battles and tournaments",
    changes: [
      { kind: "new", text: "Every trainer in the league keeps their own Pokémon." },
      { kind: "new", text: "Knockout tournaments, with a proper bracket you can follow." },
      { kind: "new", text: "Pass-the-device secret picks, so nobody can see what you chose before the battle starts." },
    ],
  },
  {
    date: "2026-08-03",
    title: "Weather, hazards, items and abilities",
    changes: [
      { kind: "new", text: "Rain, harsh sunlight, sandstorm and snow, all changing how much damage moves do." },
      { kind: "new", text: "Stealth Rock, Spikes, Toxic Spikes and Sticky Web hurt whatever comes in next." },
      { kind: "new", text: "Held items: Leftovers, Life Orb, Focus Sash, the Choice items and more." },
      { kind: "new", text: "Abilities: Intimidate, Levitate, Huge Power, Guts, Magic Guard and friends." },
    ],
  },
  {
    date: "2026-08-03",
    title: "The Battle tab",
    changes: [
      { kind: "new", text: "Pick two teams of up to six Pokémon and play the battle out turn by turn, with the working shown for every hit." },
      { kind: "new", text: "Hand a side over to the sim, or sit back and watch the whole battle play out at once." },
      { kind: "new", text: "Save the result to the league afterwards, if you want to." },
    ],
  },
  {
    date: "2026-08-03",
    title: "Every Pokémon, and the moves they really learn",
    changes: [
      { kind: "new", text: "The full Pokédex, with the actual move list each Pokémon can learn in the newest games." },
      { kind: "new", text: "It all works with no internet, so it's fine in the car." },
    ],
  },
  {
    date: "2026-08-03",
    title: "Joseph's Battle Lab opens",
    changes: [
      { kind: "new", text: "The damage calculator, showing all sixteen damage numbers a move can roll instead of pretending it's one number." },
      { kind: "new", text: "The stat leaderboards, sortable by any stat." },
      { kind: "new", text: "The family league, for keeping score." },
    ],
  },
];

/** The newest entry — doubles as the app's version stamp. */
export const LATEST = CHANGELOG[0];
