import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type { SiteContext } from "./config.ts";
import type { Remote } from "./remote.ts";

import {
  hasFlag,
  loadWorkspace,
  selectSites,
  siteDirectory,
  timestamp,
} from "./config.ts";
import { connect, quote } from "./remote.ts";

const usage = "usage: node snapshot.ts [site...] [--with-uploads] [--all-logs]";
const shouldIncludeUploads = hasFlag("with-uploads");
const shouldIncludeAllLogs = hasFlag("all-logs");
const uploadsPath = "/wp-content/uploads/";

interface Manifest {
  core: string;
  php_cli: string;
  php_dashboard: { checked: null | string; version: string }[];
}

interface CaseVariant {
  kept: string;
  original: string;
  rank: number;
  stored: string;
}

async function previousSnapshot(siteRoot: string): Promise<string | undefined> {
  try {
    return await realpath(path.join(siteRoot, "latest"));
  } catch {
    return undefined;
  }
}

async function readManifest(
  file: string,
): Promise<undefined | { excluded: string[] }> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as { excluded: string[] };
  } catch {
    return undefined;
  }
}

// Snapshots without uploads sit between uploads runs, so `latest` alone would re-download every upload
async function previousUploadsSnapshot(
  siteRoot: string,
): Promise<string | undefined> {
  const snapshots = path.join(siteRoot, "snapshots");
  let entries: string[];
  try {
    entries = await readdir(snapshots);
  } catch {
    return undefined;
  }
  const stamps = entries
    .filter((entry) => !entry.endsWith(".partial"))
    .toSorted((left, right) => right.localeCompare(left));
  for (const stamp of stamps) {
    const manifest = await readManifest(
      path.join(snapshots, stamp, "manifest.json"),
    );
    if (manifest && !manifest.excluded.includes(uploadsPath))
      return path.join(snapshots, stamp);
  }
  return undefined;
}

async function interruptedRun(directory: string): Promise<string | undefined> {
  try {
    const siblings = await readdir(directory);
    return siblings.find((entry) => entry.endsWith(".partial"));
  } catch {
    return undefined;
  }
}

function caseKey(file: string): string {
  return file.normalize("NFD").toLowerCase();
}

function caseVariantName(file: string, rank: number): string {
  const extension = path.extname(file);
  return `${file.slice(0, file.length - extension.length)}.case-${rank}${extension}`;
}

// This volume is case- and normalization-insensitive, so names the server keeps apart would overwrite each other here
async function findCaseVariants(
  context: SiteContext,
  remote: Remote,
  excluded: readonly string[],
): Promise<CaseVariant[]> {
  const prunes = excluded
    .map(
      (exclude) => `-path ${quote(`.${exclude.replace(/\/$/, "")}`)} -prune -o`,
    )
    .join(" ");
  const listing = await remote.script(
    `cd ${quote(remote.docroot)} && find . ${prunes} ! -type d -print0`,
  );
  const files = listing
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/^\.\//, ""));

  const directories = new Map<string, Set<string>>();
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const directory = path.dirname(file);
    directories.set(
      caseKey(directory),
      (directories.get(caseKey(directory)) ?? new Set()).add(directory),
    );
    groups.set(caseKey(file), [...(groups.get(caseKey(file)) ?? []), file]);
  }
  const mergedDirectories = directories
    .values()
    .filter((spellings) => spellings.size > 1)
    .toArray();
  if (mergedDirectories.length > 0) {
    const listed = mergedDirectories
      .map((spellings) => [...spellings].join(" / "))
      .join("; ");
    throw new Error(
      `${context.name}: directories differ only by case, which .case-N names can't restore: ${listed}`,
    );
  }

  const variants: CaseVariant[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Bytewise order, so the same name keeps its spelling on every run
    const [kept, ...others] = group.toSorted((first, second) =>
      Buffer.compare(Buffer.from(first), Buffer.from(second)),
    );
    if (!kept) continue;
    for (const [index, file] of others.entries())
      variants.push({
        kept,
        original: file,
        rank: index + 2,
        stored: caseVariantName(file, index + 2),
      });
  }
  const taken = variants.filter(({ stored }) => groups.has(caseKey(stored)));
  if (taken.length > 0)
    throw new Error(
      `${context.name}: the server already has files named ${taken.map(({ stored }) => stored).join(", ")}`,
    );
  return variants;
}

async function pullSite(
  context: SiteContext,
  remote: Remote,
  destination: string,
  linkSources: string[],
  excluded: readonly string[],
  variants: CaseVariant[],
): Promise<void> {
  // Hard links unchanged files to earlier snapshots, so each one costs only what changed
  const linkDestination = linkSources.map(
    (source) => `--link-dest=${path.join(source, "site")}`,
  );
  const excludes = excluded.map((exclude) => `--exclude=${exclude}`);
  const variantList = path.join(destination, "case-variants.exclude");
  await writeFile(
    variantList,
    variants
      .map(
        ({ original }) =>
          `/${original.replaceAll(/[*?[\\]/g, String.raw`\$&`)}\n`,
      )
      .join(""),
  );
  const exitCode = await remote.pull(
    remote.docroot,
    path.join(destination, "site"),
    [
      "-a",
      "--stats",
      ...linkDestination,
      ...excludes,
      `--exclude-from=${variantList}`,
    ],
    { isLive: true },
  );
  if (exitCode !== 0)
    throw new Error(`${context.name}: docroot rsync exited ${exitCode}`);
  await rm(variantList);
}

async function pullCaseVariants(
  context: SiteContext,
  remote: Remote,
  destination: string,
  variants: CaseVariant[],
): Promise<void> {
  const ranks = [...new Set(variants.map(({ rank }) => rank))];
  for (const rank of ranks) {
    const staging = path.join(destination, `.case-${rank}`);
    const list = `${staging}.files`;
    const ranked = variants.filter((variant) => variant.rank === rank);
    await writeFile(
      list,
      ranked.map(({ original }) => `${original}\n`).join(""),
    );
    const exitCode = await remote.pull(remote.docroot, staging, [
      "-a",
      `--files-from=${list}`,
    ]);
    if (exitCode !== 0)
      throw new Error(`${context.name}: case-variant rsync exited ${exitCode}`);
    for (const { original, stored } of ranked) {
      // A resumed run finds the previous attempt's copy here
      const target = path.join(destination, "site", stored);
      await rm(target, { force: true });
      await rename(path.join(staging, original), target);
    }
    await rm(staging, { recursive: true });
    await rm(list);
  }
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function writeCaseIndex(
  destination: string,
  variants: CaseVariant[],
): Promise<void> {
  const files = [...new Set(variants.map(({ kept }) => kept))].map((kept) => ({
    original: kept,
    stored: kept,
  }));
  files.push(...variants);
  files.sort(
    (first, second) =>
      caseKey(first.original).localeCompare(caseKey(second.original)) ||
      first.stored.localeCompare(second.stored),
  );
  const digests = await Promise.all(
    files.map(({ stored }) => sha256(path.join(destination, "site", stored))),
  );

  const lines = [
    "# Case collisions",
    "",
    `The docroot holds ${files.length} files whose paths differ only by case (or Unicode normalization) from another's. This volume can't keep such names apart, so \`site/\` stores the bytewise-first name of each set as is and the others as \`<name>.case-<n>.<ext>\`. Paths are relative to the docroot.`,
    "",
    "## Putting them back",
    "",
    "Only on a case-sensitive filesystem, such as the server. After copying `site/` there, run from that docroot:",
    "",
    "```sh",
    ...variants.map(
      ({ original, stored }) => `mv -n ${quote(stored)} ${quote(original)}`,
    ),
    "```",
    "",
    "Then check every file of each set against the server originals:",
    "",
    "```sh",
    "sha256sum -c <<'EOF'",
    ...files.map(({ original }, index) => `${digests[index]}  ${original}`),
    "EOF",
    "```",
    "",
    "## Index",
    "",
    "| Original path | Stored as |",
    "| --- | --- |",
    ...files.map(
      ({ original, stored }) =>
        `| \`${original}\` | ${original === stored ? "unchanged" : `\`${stored}\``} |`,
    ),
    "",
  ];
  await writeFile(
    path.join(destination, "case-collisions.md"),
    lines.join("\n"),
  );
}

async function makeReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeReadOnly(target);
    else await chmod(target, 0o444);
  }
  await chmod(directory, 0o555);
}

// rsync exit 23 means some files were unreadable; the rest copied, so the run records the gap and goes on
async function pullLogs(
  context: SiteContext,
  remote: Remote,
  destination: string,
  stamp: string,
): Promise<{ allLogs: null | string; warnings: string[] }> {
  const { server, site } = context;
  if (!site.logRoot)
    return {
      allLogs: null,
      warnings: ["no logRoot configured; no logs pulled"],
    };

  const warnings: string[] = [];
  const includes = (server.currentLogs ?? ["*.log", "*.log.1"]).map(
    (pattern) => `--include=${pattern}`,
  );
  const current = await remote.pull(
    site.logRoot,
    path.join(destination, "logs"),
    ["-a", ...includes, "--exclude=*"],
  );
  if (current === 23)
    warnings.push("some current logs were unreadable (rsync exit 23)");
  else if (current !== 0)
    throw new Error(`${context.name}: log rsync exited ${current}`);
  if (!shouldIncludeAllLogs) return { allLogs: null, warnings };

  const archive = path.join(
    context.workspace.root,
    "archive",
    `logs-${stamp}`,
    context.name,
  );
  await mkdir(archive, { recursive: true });
  const retained = await remote.pull(site.logRoot, archive, ["-a"]);
  if (retained === 23)
    warnings.push(
      "some retained logs were unreadable (rsync exit 23); list the missing files in the report",
    );
  else if (retained !== 0)
    throw new Error(`${context.name}: retained-log rsync exited ${retained}`);
  await makeReadOnly(archive);
  return { allLogs: path.relative(context.workspace.root, archive), warnings };
}

async function inspectDump(
  file: string,
): Promise<{ charset: string | undefined; tables: number; trailer: string }> {
  let header = "";
  let carry = "";
  let lastLine = "";
  let tables = 0;
  // latin1 keeps one character per byte, so a multibyte character split across chunks can't corrupt a line
  await pipeline(
    createReadStream(file),
    createGunzip(),
    async function (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        const text = carry + chunk.toString("latin1");
        if (header.length < 16_384)
          header += text.slice(0, 16_384 - header.length);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("CREATE TABLE")) tables++;
          if (line.trim() !== "") lastLine = line;
        }
      }
    },
  );
  if (carry.trim() !== "") lastLine = carry;
  const charset = /^\/\*!40101 SET NAMES (\w+) \*\/;$/m.exec(header)?.[1];
  return { charset, tables, trailer: lastLine };
}

async function dumpDatabase(
  context: SiteContext,
  remote: Remote,
  destination: string,
): Promise<{ bytes: number; tables: number }> {
  const file = path.join(destination, "db.sql.gz");
  // WP-CLI upgrades DB_CHARSET 'utf8' only when exactly one `%_posts` table exists; a 3-byte dump turns every emoji into `?`
  const exportArguments = [
    "db",
    "export",
    "-",
    "--default-character-set=utf8mb4",
    "--single-transaction",
    "--quick",
    ...(context.server.dumpOptions ?? []),
  ];
  await remote.scriptToFile(
    `${remote.wpCommand(exportArguments)} | gzip -c`,
    file,
  );

  const dump = await inspectDump(file);
  if (dump.charset !== "utf8mb4")
    throw new Error(
      `${context.name}: dump sets names ${dump.charset ?? "(none)"}, expected utf8mb4`,
    );
  if (!dump.trailer.includes("Dump completed"))
    throw new Error(
      `${context.name}: dump has no completion trailer, got: ${dump.trailer.slice(0, 120)}`,
    );

  const liveTables = await remote.php<number>(
    String.raw`<?php global $wpdb; echo wp_json_encode( (int) $wpdb->get_var( "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'" ) ) . "\n";`,
  );
  if (dump.tables !== liveTables)
    throw new Error(
      `${context.name}: dump has ${dump.tables} tables, live database has ${liveTables}`,
    );
  const { size } = await stat(file);
  return { bytes: size, tables: dump.tables };
}

// What the web side reports, since the CLI's PHP can differ from the one serving pages
async function servedPhpHeader(url: string): Promise<null | string> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    return response.headers.get("x-powered-by");
  } catch {
    return null;
  }
}

async function snapshot(context: SiteContext, stamp: string): Promise<void> {
  const siteRoot = siteDirectory(context);
  const final = path.join(siteRoot, "snapshots", stamp);
  // A failed run stays a .partial folder that `latest` never points at
  const destination = `${final}.partial`;
  const excluded = [
    ...(shouldIncludeUploads ? [] : [uploadsPath]),
    ...(context.workspace.config.snapshotExcludes ?? []),
  ];
  const previous = await previousSnapshot(siteRoot);
  const uploadsSource = shouldIncludeUploads
    ? await previousUploadsSnapshot(siteRoot)
    : undefined;
  const linkSources = [
    ...new Set(
      [previous, uploadsSource].filter((source) => source !== undefined),
    ),
  ];
  // Adopting an interrupted run's folder lets rsync resume instead of starting over
  const interrupted = await interruptedRun(path.dirname(final));
  if (interrupted)
    await rename(path.join(path.dirname(final), interrupted), destination);
  await mkdir(path.join(destination, "logs"), { recursive: true });

  const remote = connect(context);
  console.log(
    `\n=== ${context.name} (${context.site.url}) via ${remote.label} -> ${path.relative(context.workspace.root, final)}`,
  );
  const manifest = await remote.php<Manifest>(
    await readFile(new URL("php/manifest.php", import.meta.url), "utf8"),
  );
  const header = await servedPhpHeader(context.site.url);
  const dashboard =
    manifest.php_dashboard
      .map(({ checked, version }) => `${version} (${checked ?? "undated"})`)
      .join(", ") || "none cached";
  console.log(
    `${context.name}: WordPress ${manifest.core}; served PHP: header ${header ?? "absent"}, dashboard ${dashboard}; CLI PHP ${manifest.php_cli}`,
  );

  // Database first so a long uploads transfer can't leave a site without its dump
  const database = await dumpDatabase(context, remote, destination);
  console.log(
    `${context.name}: db ok, ${database.tables} tables, ${(database.bytes / 1024 / 1024).toFixed(1)}MB`,
  );
  const logs = await pullLogs(context, remote, destination, stamp);
  for (const warning of logs.warnings)
    console.log(`${context.name}: ${warning}`);
  if (logs.allLogs)
    console.log(
      `${context.name}: every retained log in ${logs.allLogs} (read-only)`,
    );
  const variants = await findCaseVariants(context, remote, excluded);
  await pullSite(context, remote, destination, linkSources, excluded, variants);
  if (variants.length > 0) {
    await pullCaseVariants(context, remote, destination, variants);
    await writeCaseIndex(destination, variants);
    console.log(
      `${context.name}: ${variants.length} case-collision files stored as .case-N, see case-collisions.md`,
    );
  }

  const record = {
    case_variants: variants.map(({ original, stored }) => ({
      original,
      stored,
    })),
    database_bytes: database.bytes,
    database_tables: database.tables,
    excluded,
    linked: linkSources,
    logs: { all_retained: logs.allLogs, warnings: logs.warnings },
    previous: previous ?? null,
    served_php: { dashboard: manifest.php_dashboard, header },
    site: context.name,
    taken: stamp,
    transport: context.server.transport,
    url: context.site.url,
    wordpress: manifest,
  };
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(record, null, "\t")}\n`,
  );

  await rename(destination, final);
  const latest = path.join(siteRoot, "latest");
  await rm(latest, { force: true });
  await symlink(path.join("snapshots", stamp), latest);
  console.log(`${context.name}: snapshot complete`);
}

if (hasFlag("help")) {
  console.log(usage);
  process.exit(0);
}
const workspace = await loadWorkspace();
const stamp = timestamp();
const failures: string[] = [];
for (const context of selectSites(workspace)) {
  try {
    await snapshot(context, stamp);
  } catch (error) {
    failures.push(context.name);
    console.error(
      `${context.name}: FAILED`,
      error instanceof Error ? error.message : error,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nFailed: ${failures.join(", ")}`);
  process.exit(1);
}
