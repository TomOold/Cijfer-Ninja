// Builds /home/user/Cijfer-Ninja/rekenrace/index.html from the part files and the UI sources.
// usage: node assemble.mjs            (writes the file, prints size and checks)
// The pure modules go between // ===PURE=== and // ===ENDPURE=== so Node tests can load them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "/home/user/Cijfer-Ninja/rekenrace/index.html";
const read = (f) => fs.readFileSync(f, "utf8");
const parts = (f) => read(path.join(SP, "parts", f)).replace(/\s+$/, "");
const ui = (f) => read(path.join(SP, "ui", f)).replace(/\s+$/, "");

const script = [
  "const RR = {};",
  "// ===PURE===",
  parts("pure-rng.js"),
  parts("pure-sommen.js"),
  parts("pure-race.js"),
  parts("pure-opslag.js"),
  "// ===ENDPURE===",
  parts("sprites.js"),
  parts("scene.js"),
  parts("geluid.js"),
  ui("ui.js"),
].join("\n");

if (/<\/script/i.test(script)) throw new Error("script contains </script - escape it");
if (/<!--/.test(script)) throw new Error("script contains <!-- - escape it");

let html = ui("template.html");
for (const marker of ["/*@CSS@*/", "/*@SCRIPT@*/"]) {
  if (html.split(marker).length !== 2) throw new Error("template must contain " + marker + " exactly once");
}
html = html.replace("/*@CSS@*/", () => ui("ui.css")).replace("/*@SCRIPT@*/", () => script);
if (!html.endsWith("\n")) html += "\n";

fs.writeFileSync(OUT, html);
const fence = html.match(/\/\/ ===PURE===([\s\S]*?)\/\/ ===ENDPURE===/);
console.log("wrote", OUT, (html.length / 1024).toFixed(0) + " KB,", html.split("\n").length, "lines; pure block", fence ? (fence[1].length / 1024).toFixed(0) + " KB" : "MISSING");
