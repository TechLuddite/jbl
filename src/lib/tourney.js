/**
 * Single-elimination bracket logic for the league tourney.
 *
 * A slot holds a trainer id (number), null (a bye), or undefined (still
 * waiting on an earlier match). That distinction is load-bearing: undefined
 * round-trips through JSON as a missing key, which reads back as undefined,
 * so persisted brackets keep the same semantics.
 *
 * Like battle.js and sim.js, this file is covered by hand-derived tests in
 * tourney.test.js. If a test fails after your change, the change is wrong.
 */

/** Build a bracket from an ordered list of trainer ids (2+). The list is
 *  padded with byes up to the next power of two, and every match a bye
 *  decides is settled immediately. */
export function createBracket(ids) {
  let size = 1;
  while (size < ids.length) size *= 2;
  const seeds = [...ids];
  while (seeds.length < size) seeds.push(null);

  const rounds = [];
  for (let matches = size / 2; matches >= 1; matches = Math.floor(matches / 2)) {
    rounds.push(Array.from({ length: matches }, () => ({ a: undefined, b: undefined, winner: undefined })));
  }
  rounds[0].forEach((m, i) => {
    m.a = seeds[2 * i];
    m.b = seeds[2 * i + 1];
  });
  return resolveByes({ rounds });
}

/** Record a played match and push the winner into the next round. */
export function reportWinner(bracket, round, index, winnerId) {
  const b = clone(bracket);
  b.rounds[round][index].winner = winnerId;
  push(b, round, index, winnerId);
  return resolveByes(b);
}

/** Matches that are ready to play: both sides are real trainers, no result yet. */
export function pendingMatches(bracket) {
  const out = [];
  bracket.rounds.forEach((round, r) =>
    round.forEach((m, i) => {
      if (m.winner === undefined && m.a != null && m.b != null) {
        out.push({ round: r, index: i, a: m.a, b: m.b });
      }
    })
  );
  return out;
}

/** The tourney winner, or null while the final is unplayed. */
export function championOf(bracket) {
  return bracket.rounds[bracket.rounds.length - 1][0].winner ?? null;
}

function clone(bracket) {
  return { rounds: bracket.rounds.map((round) => round.map((m) => ({ ...m }))) };
}

function push(bracket, round, index, winner) {
  const next = bracket.rounds[round + 1];
  if (!next) return;
  const m = next[Math.floor(index / 2)];
  if (index % 2 === 0) m.a = winner;
  else m.b = winner;
}

/**
 * Settle every match whose outcome a bye forces. One forward pass is enough:
 * pushes only ever write into later rounds, which this loop hasn't reached
 * yet. Two byes meeting produce a bye as their "winner", so empty branches
 * keep collapsing until they hit a real trainer.
 */
function resolveByes(bracket) {
  const b = clone(bracket);
  b.rounds.forEach((round, r) =>
    round.forEach((m, i) => {
      if (m.winner === undefined && m.a !== undefined && m.b !== undefined && (m.a === null || m.b === null)) {
        m.winner = m.a ?? m.b;
        push(b, r, i, m.winner);
      }
    })
  );
  return b;
}
