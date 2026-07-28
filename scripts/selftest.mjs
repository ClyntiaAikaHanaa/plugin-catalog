#!/usr/bin/env node
//
// Uji cepat perkakas katalog terhadap berkas nyata.
//
// Bukan pengganti CI — ini yang dijalankan sebelum menyentuh katalog, untuk
// memastikan pembaca ZIP dan penurun metadata masih bekerja setelah disunting.
//
//   node scripts/selftest.mjs [folder-berisi-zip]

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { readArchiveRoot, readZipEntryNames } from "./lib.mjs";
import { parseReadmeHeader } from "./ingest.mjs";

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    console.log(`      diharapkan: ${JSON.stringify(expected)}`);
    console.log(`      didapat   : ${JSON.stringify(actual)}`);
    failed += 1;
  }
};

// ── parseReadmeHeader ────────────────────────────────────────────────────
console.log("parseReadmeHeader");

const readme = [
  "<div align=\"center\">",
  "",
  "# Ring Mood",
  "",
  "**Ring Modulator with Selectable Modulator Sources**",
  "",
  "A VST3 effect for Windows. The input is multiplied by a modulator you choose.",
  "Written in C++20 on JUCE.",
  "",
  "## What it does",
  "",
  "Ring modulation multiplies two signals together.",
].join("\n");

const parsed = parseReadmeHeader(readme);
check("judul", parsed.title, "Ring Mood");
check("tagline", parsed.tagline, "Ring Modulator with Selectable Modulator Sources");
check(
  "paragraf berhenti di heading berikutnya",
  parsed.description,
  "A VST3 effect for Windows. The input is multiplied by a modulator you choose. Written in C++20 on JUCE."
);

check("README kosong tidak melempar", parseReadmeHeader("").title, null);
check("README tanpa H1", parseReadmeHeader("teks biasa saja").title, null);

// ── readArchiveRoot ──────────────────────────────────────────────────────
console.log("\nreadArchiveRoot");

const dir = process.argv[2] ?? join(process.cwd(), "..", "release-assets");
let zips = [];
try {
  zips = (await readdir(dir)).filter((n) => n.endsWith(".zip")).sort();
} catch {
  console.log(`  · ${dir} tidak ada — bagian ini dilewati`);
}

for (const name of zips) {
  const buffer = await readFile(join(dir, name));
  try {
    const root = readArchiveRoot(buffer);
    const count = readZipEntryNames(buffer).length;
    console.log(`  ✓ ${name} → akar "${root}", ${count} entri`);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed += 1;
  }
}

// Arsip cacat: bukan ZIP sama sekali.
try {
  readArchiveRoot(Buffer.from("bukan zip"));
  console.log("  ✗ data acak seharusnya ditolak");
  failed += 1;
} catch {
  console.log("  ✓ data acak ditolak");
}

console.log(failed === 0 ? "\nSemua lolos." : `\n${failed} gagal.`);
process.exit(failed === 0 ? 0 : 1);
