// Loads the pure (DOM-free) part of either standalone game.
// Defaults to the original; use laadRR("rekenracev2") for the adventure.
//
// index.html fences its pure modules between `// ===PURE===` and
// `// ===ENDPURE===` (same convention as the main game / wbtest.js). The
// fenced code assigns to a shared `RR` namespace, so we evaluate it inside a
// function that declares `RR` first. Running in the main realm (not a vm
// context) keeps arrays/objects comparable with assert.deepStrictEqual.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));


function pureSource(game) {
  if (!["rekenrace", "rekenracev2"].includes(game)) throw new Error("Unknown Rekenrace version");
  const indexPath = path.join(here, "..", "..", game, "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const m = html.match(/\/\/ ===PURE===([\s\S]*?)\/\/ ===ENDPURE===/);
  if (!m) throw new Error("PURE block missing in " + game + "/index.html");
  return m[1];
}

export function laadRR(game = "rekenrace") {
  return new Function('"use strict"; const RR = {};\n' + pureSource(game) + "\n;return RR;")();
}
