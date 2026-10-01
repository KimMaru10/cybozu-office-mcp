// 配布物（dist/index.js）に同梱される依存パッケージのライセンス表記をまとめる
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const r = await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "error" });
const pkgs = new Set();
for (const k of Object.keys(r.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(k);
  if (m) pkgs.add(m[1]);
}
let out = "このソフトウェアの配布物には、次のオープンソースソフトウェアが含まれています。\nThis distribution bundles the following third-party software.\n";
for (const p of [...pkgs].sort()) {
  const dir = path.join("node_modules", p);
  const j = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const lf = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  out += `\n${"=".repeat(70)}\n${p}@${j.version} (${j.license})\n${"=".repeat(70)}\n`;
  out += lf ? fs.readFileSync(path.join(dir, lf), "utf8").trim() + "\n" : `License: ${j.license}\n`;
}
fs.writeFileSync("THIRD_PARTY_LICENSES.txt", out);
console.log(`THIRD_PARTY_LICENSES.txt: ${pkgs.size} packages`);
