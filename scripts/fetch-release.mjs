#!/usr/bin/env node
//
// Tarik satu rilis ke katalog (PRD §10.5). Dipanggil `on-plugin-release.yml`
// saat repo plugin mengirim `repository_dispatch` setelah tag di-push.
//
// Jalur ini dan `sync-repos.mjs` memakai logika ingest yang sama; bedanya
// hanya bagaimana rilisnya ditemukan. Yang ini tahu `breaking`/`security` dari
// payload dispatch — informasi yang tidak bisa disimpulkan pemindaian.
//
// Pemakaian:
//   node scripts/fetch-release.mjs --plugin mycomp --repo akun/MyComp \
//        --tag v1.3.0 [--breaking true] [--security true]

import { Outcome, ingestRelease } from "./ingest.mjs";

const args = parseArgs(process.argv.slice(2));
for (const required of ["plugin", "repo", "tag"]) {
  if (!args[required]) {
    console.error(`--${required} wajib diisi`);
    process.exit(2);
  }
}

const result = await ingestRelease({
  pluginId: args.plugin,
  repo: args.repo,
  tag: args.tag,
  breaking: args.breaking,
  security: args.security,
});

if (result.outcome === Outcome.Skipped) {
  // Rilis yang dilewati bukan kegagalan workflow — dispatch bisa terkirim dua
  // kali, atau tag dipublikasikan ulang.
  console.log(`· ${args.plugin} — ${result.reason}`);
  process.exit(0);
}

console.log(
  `✓ ${args.plugin} ${result.version} — sha256 ${result.sha256.slice(0, 16)}… ` +
    `(${result.sizeBytes} byte)`
);

if (result.outcome === Outcome.Created) {
  console.log(
    `  File plugin baru dibuat dengan hidden:true. Sunting kategori dan\n` +
      `  requirements-nya, lalu set hidden:false supaya tampil di launcher.`
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
