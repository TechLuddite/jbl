---
description: Run the full check that CI runs, and report honestly
---

Run these in order and report the result of each:

1. `npm run test:run`
2. `npm run build`
3. Confirm `dist/CNAME` exists and contains `jbl.opsvibe.systems`

If anything fails, diagnose it and propose a fix — but do not change expected
values in `src/lib/battle.test.js` to make a test pass. A failing math test
means the implementation is wrong.

Report pass/fail plainly. Do not claim success unless all three passed.
