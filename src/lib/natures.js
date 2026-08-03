/**
 * All 25 natures as [raisedStat, loweredStat].
 * The five neutral natures have both null.
 */
export const NATURES = {
  hardy: [null, null], docile: [null, null], serious: [null, null],
  bashful: [null, null], quirky: [null, null],

  lonely: ["atk", "def"], brave: ["atk", "spe"], adamant: ["atk", "spa"], naughty: ["atk", "spd"],
  bold: ["def", "atk"], relaxed: ["def", "spe"], impish: ["def", "spa"], lax: ["def", "spd"],
  timid: ["spe", "atk"], hasty: ["spe", "def"], jolly: ["spe", "spa"], naive: ["spe", "spd"],
  modest: ["spa", "atk"], mild: ["spa", "def"], quiet: ["spa", "spe"], rash: ["spa", "spd"],
  calm: ["spd", "atk"], gentle: ["spd", "def"], sassy: ["spd", "spe"], careful: ["spd", "spa"],
};

/** Returns 1.1, 0.9 or 1 for a given nature/stat pair. Never applies to HP. */
export function natureModFor(nature, stat) {
  const [up, down] = NATURES[nature] ?? [null, null];
  if (stat === "hp") return 1;
  if (up === stat) return 1.1;
  if (down === stat) return 0.9;
  return 1;
}
