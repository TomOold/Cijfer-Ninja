// Loads the pure (DOM-free) part of rekenrace/index.html for headless tests.
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
const indexPath = path.join(here, "..", "..", "rekenrace", "index.html");

function pureSource() {
  const html = fs.readFileSync(indexPath, "utf8");
  const m = html.match(/\/\/ ===PURE===([\s\S]*?)\/\/ ===ENDPURE===/);
  if (!m) throw new Error("PURE block missing in rekenrace/index.html");
  return m[1];
}

export function laadRR() {
  return new Function('"use strict"; const RR = {};\n' + pureSource() + "\n;return RR;")();
}
