import { describe, it, expect } from "vitest";
import { createBracket, reportWinner, pendingMatches, championOf } from "./tourney.js";

/*
 * Expected shapes worked out by hand on paper brackets. If one of these
 * fails, fix the code, not the numbers.
 */

describe("createBracket", () => {
  it("two players make a single final", () => {
    const b = createBracket([10, 20]);
    expect(b.rounds).toHaveLength(1);
    expect(b.rounds[0]).toHaveLength(1);
    expect(pendingMatches(b)).toEqual([{ round: 0, index: 0, a: 10, b: 20 }]);
    expect(championOf(b)).toBeNull();
  });

  it("three players give the last seed a bye into the final", () => {
    const b = createBracket([1, 2, 3]);
    expect(b.rounds).toHaveLength(2);
    // 3 vs bye settles itself and 3 waits in the final.
    expect(b.rounds[0][1].winner).toBe(3);
    expect(b.rounds[1][0].b).toBe(3);
    expect(pendingMatches(b)).toEqual([{ round: 0, index: 0, a: 1, b: 2 }]);
  });

  it("five players collapse the empty branch all the way to the semi", () => {
    const b = createBracket([1, 2, 3, 4, 5]);
    expect(b.rounds).toHaveLength(3);
    // Round 1 on paper: [1v2] [3v4] [5 v bye] [bye v bye].
    expect(b.rounds[0][2].winner).toBe(5);
    expect(b.rounds[0][3].winner).toBeNull(); // two byes meet, a bye advances
    // So the second semi is 5 v bye, which settles too: 5 straight to the final.
    expect(b.rounds[1][1].winner).toBe(5);
    expect(b.rounds[2][0].b).toBe(5);
    expect(pendingMatches(b)).toEqual([
      { round: 0, index: 0, a: 1, b: 2 },
      { round: 0, index: 1, a: 3, b: 4 },
    ]);
  });
});

describe("reportWinner", () => {
  it("plays a four-player bracket through to a champion", () => {
    let b = createBracket([1, 2, 3, 4]);
    b = reportWinner(b, 0, 0, 1);
    b = reportWinner(b, 0, 1, 4);
    expect(pendingMatches(b)).toEqual([{ round: 1, index: 0, a: 1, b: 4 }]);
    expect(championOf(b)).toBeNull();
    b = reportWinner(b, 1, 0, 4);
    expect(championOf(b)).toBe(4);
    expect(pendingMatches(b)).toHaveLength(0);
  });

  it("routes winners to the right side of the next match", () => {
    let b = createBracket([1, 2, 3, 4]);
    b = reportWinner(b, 0, 1, 3); // second match feeds slot b
    expect(b.rounds[1][0].a).toBeUndefined();
    expect(b.rounds[1][0].b).toBe(3);
  });

  it("does not mutate the bracket it was given", () => {
    const before = createBracket([1, 2, 3, 4]);
    reportWinner(before, 0, 0, 2);
    expect(before.rounds[0][0].winner).toBeUndefined();
  });

  it("plays the five-player bracket: winner still has to beat the bye-riding seed", () => {
    let b = createBracket([1, 2, 3, 4, 5]);
    b = reportWinner(b, 0, 0, 1);
    b = reportWinner(b, 0, 1, 4);
    expect(pendingMatches(b)).toEqual([{ round: 1, index: 0, a: 1, b: 4 }]);
    b = reportWinner(b, 1, 0, 4);
    expect(pendingMatches(b)).toEqual([{ round: 2, index: 0, a: 4, b: 5 }]);
    b = reportWinner(b, 2, 0, 5);
    expect(championOf(b)).toBe(5);
  });

  it("survives a JSON round-trip, like the storage layer does to it", () => {
    let b = createBracket([1, 2, 3]);
    b = JSON.parse(JSON.stringify(b));
    expect(pendingMatches(b)).toEqual([{ round: 0, index: 0, a: 1, b: 2 }]);
    b = reportWinner(b, 0, 0, 2);
    expect(pendingMatches(b)).toEqual([{ round: 1, index: 0, a: 2, b: 3 }]);
  });
});
