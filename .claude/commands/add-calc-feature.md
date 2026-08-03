---
description: Add a mechanic to the damage calculator, test-first
---

Adding anything to the damage calculator (held items, abilities, weather, stat
stages, screens, multi-hit moves) follows this order:

1. **Read `src/lib/battle.js` first.** Understand where in the Gen 5+ modifier
   chain the new mechanic belongs. Order is:
   base → targets → weather → crit → random → STAB → type → burn → other.
2. **Write the test first** in `src/lib/battle.test.js`, with the expected value
   derived by hand and the derivation written in a comment.
3. Implement in `battle.js`. The existing 20 tests must still pass.
4. Surface it in `src/features/DamageCalc.jsx` — and add it to the
   "showing the work" steps. A mechanic the user can't see the effect of is
   half-implemented.
5. Run `/verify`.

Ask me before adding a mechanic that would need new data fields on the dex
entries, since that means re-baking the dataset.
