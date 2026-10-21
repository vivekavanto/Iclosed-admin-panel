import type { Matter } from "./model.ts";
export const MATTER_ROOT = "1dh2IYRvRqvQk9om86fFlqzqqG6oQJaXj";
const aliases: Record<string, string> = { street:"st",road:"rd",avenue:"ave",boulevard:"blvd",crescent:"cres",cr:"cres",court:"ct",crt:"ct",drive:"dr",place:"pl",lane:"ln",terrace:"terr",trail:"trl",square:"sq",highway:"hwy",parkway:"pkwy" };
function tokens(text: string) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(t => aliases[t] || t);
}
export function folderMatchesMatter(matter: Pick<Matter, "number" | "address">, name: string) {
  const number = matter.number.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const match = new RegExp(`^\\s*${number}(?![a-z0-9])`, "i").exec(name);
  if (!match) return false;
  const expected = tokens(matter.address.split(",")[0]);
  const actual = tokens(name.slice(match[0].length));
  // Require both street/address words and every number (including the unit).
  return expected.some(t => /^\d/.test(t)) && expected.some(t => /^[a-z]/.test(t)) && expected.every(t => actual.includes(t));
}
