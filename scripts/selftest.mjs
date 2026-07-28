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
import { applyManifest, parseReadmeHeader } from "./ingest.mjs";

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

// ── applyManifest ────────────────────────────────────────────────────────
console.log("\napplyManifest");

const base = () => ({
  category: "utility",
  vendor: "Turunan",
  tagline: "Derived tagline",
  tagline_i18n: {},
  description_i18n: {},
  user_data: { preset_paths: [], config_paths: [] },
  requirements: { os_min_build: 17763, cpu_features: ["sse2"] },
});

const withManifest = applyManifest(base(), {
  category: "reverb",
  vendor: "AnakBaek DSP",
  tagline_i18n: { id: "Reverb algoritmik" },
  description_i18n: { id: "Deskripsi Indonesia." },
  user_data: { preset_paths: ["%USERPROFILE%\\Documents\\X\\Presets"] },
  requirements: { cpu_features: ["sse4.2"] },
});

check("kategori dari manifes", withManifest.category, "reverb");
check("vendor dari manifes", withManifest.vendor, "AnakBaek DSP");
check("terjemahan tagline", withManifest.tagline_i18n, { id: "Reverb algoritmik" });
check("terjemahan deskripsi", withManifest.description_i18n, { id: "Deskripsi Indonesia." });
check("preset_paths", withManifest.user_data.preset_paths, [
  "%USERPROFILE%\\Documents\\X\\Presets",
]);
check(
  "requirements digabung, bukan diganti",
  withManifest.requirements,
  { os_min_build: 17763, cpu_features: ["sse4.2"] }
);

// Kategori asal tidak boleh lolos: ia menentukan di mana plugin muncul di UI,
// dan nilai yang tidak dikenal membuat filter kategori diam-diam kosong.
check("kategori tak dikenal ditolak", applyManifest(base(), { category: "kopi" }).category, "utility");

// Manifes yang hilang atau rusak tidak boleh mengubah apa pun.
check("manifes null", applyManifest(base(), null).category, "utility");
check("manifes bukan objek", applyManifest(base(), "teks").category, "utility");
check("manifes kosong", applyManifest(base(), {}).tagline_i18n, {});

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
