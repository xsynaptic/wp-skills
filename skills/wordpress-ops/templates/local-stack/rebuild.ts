// Rebuilds this rehearsal stack from a verified snapshot; prints the plan and checks the dump unless passed --apply
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";

interface ComposePort {
  published?: string;
}

interface ComposeVolume {
  source?: string;
  target: string;
}

interface ComposeService {
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
}

interface ComposeConfig {
  name: string;
  services: Record<string, ComposeService>;
}

interface DumpCheck {
  hasUtf8mb4Header: boolean;
  isComplete: boolean;
  tableCount: number;
}

interface WebService {
  logFolder: string;
  name: string;
  port: string;
}

const usage = `usage, from sites/<name>/local/: node rebuild.ts --snapshot ../snapshots/<stamp> [--uploads <uploads folder>] [--repair-core] [--apply]
Checks the dump and prints the plan; --apply rebuilds. --uploads copies uploads from another snapshot's site/wp-content/uploads,
and --repair-core reinstalls core at its own version and removes files core doesn't ship.`;
const stackFolder = process.cwd();
const databaseName = "wordpress";
const rootPassword = "wordpress";
const cacheDropIns = [
  "advanced-cache.php",
  "db.php",
  "object-cache.php",
] as const;
const settingsRequire =
  /^\s*require(_once)?\s*\(?\s*ABSPATH\s*\.\s*['"]wp-settings\.php['"]/;

function fail(message: string): never {
  console.error(`rebuild failed: ${message}`);
  process.exit(1);
}

function report(message: string): void {
  console.log(`- ${message}`);
}

function run(command: string, commandArguments: readonly string[], input = "") {
  const result = spawnSync(command, commandArguments, {
    cwd: stackFolder,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function must(
  command: string,
  commandArguments: readonly string[],
  input = "",
): string {
  const result = run(command, commandArguments, input);
  if (result.status !== 0) {
    // PHP fatals reach stdout, so an empty stderr falls back to it
    fail(
      `${command} ${commandArguments.join(" ")}\n${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`,
    );
  }
  return result.stdout.trim();
}

function docker(dockerArguments: readonly string[]): void {
  const result = spawnSync("docker", dockerArguments, {
    cwd: stackFolder,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(
      `docker ${dockerArguments.join(" ")} exited ${result.status ?? "on a signal"}`,
    );
  }
}

// Plugins and themes stay unloaded, implants included; drop-ins still load, so rebuild leaves the cache ones out
function wp(wpArguments: readonly string[], input = ""): string {
  return must(
    "docker",
    [
      "compose",
      "run",
      "--rm",
      "-T",
      "cli",
      "wp",
      ...wpArguments,
      "--skip-plugins",
      "--skip-themes",
    ],
    input,
  );
}

function sql(query: string): string {
  return must("docker", [
    "compose",
    "exec",
    "-T",
    "db",
    "mariadb",
    "-uroot",
    `-p${rootPassword}`,
    "-N",
    databaseName,
    "-e",
    query,
  ]);
}

function clone(source: string, destination: string): void {
  const flags =
    process.platform === "darwin" ? ["-cRp"] : ["-a", "--reflink=auto"];
  must("cp", [...flags, source, destination]);
}

async function inspectDump(dumpFile: string): Promise<DumpCheck> {
  const lines = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(dumpFile).pipe(createGunzip()),
  });
  let lineNumber = 0;
  let hasUtf8mb4Header = false;
  let tableCount = 0;
  let lastLine = "";
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber <= 40 && line.includes("SET NAMES utf8mb4")) {
      hasUtf8mb4Header = true;
    }
    if (line.startsWith("CREATE TABLE")) {
      tableCount += 1;
    }
    if (line !== "") {
      lastLine = line;
    }
  }
  return {
    hasUtf8mb4Header,
    isComplete: lastLine.startsWith("-- Dump completed"),
    tableCount,
  };
}

function readCompose(): ComposeConfig {
  const result = run("docker", ["compose", "config", "--format", "json"]);
  if (result.status !== 0) {
    fail(
      `compose.yaml doesn't resolve; replace every <placeholder> first\n${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}

function webServices(config: ComposeConfig): WebService[] {
  const services: WebService[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    const port = service.ports?.[0]?.published;
    const logFolder = service.volumes?.find(
      (volume) => volume.target === "/var/log/wordpress",
    )?.source;
    if (port === undefined || logFolder === undefined) {
      continue;
    }
    services.push({ logFolder, name, port });
  }
  return services;
}

function localNames(): string[] {
  const text = readFileSync(
    path.join(stackFolder, "wp-config-local.php"),
    "utf8",
  );
  return text
    .matchAll(/define\(\s*'([A-Z0-9_]+)'/g)
    .map((match) => match[1] ?? "")
    .toArray();
}

// Live defines of the names wp-config-local.php sets are commented out, since a second define keeps the first value
function localiseConfig(configText: string, names: readonly string[]): string {
  const lines = configText.split("\n");
  const settingsIndex = lines.findIndex((line) => settingsRequire.test(line));
  if (settingsIndex === -1) {
    fail(
      "site/wp-config.php has no require of wp-settings.php to anchor the local include before",
    );
  }
  const lineEnding = lines[settingsIndex]?.endsWith("\r") ? "\r" : "";
  const localised = lines.map((line) => {
    const name = /^\s*define\s*\(\s*(['"])([A-Z0-9_]+)\1/.exec(line)?.[2];
    if (name === undefined || !names.includes(name)) {
      return line;
    }
    if (!line.includes(";")) {
      fail(
        `site/wp-config.php defines ${name} across several lines; comment it out by hand`,
      );
    }
    return `// local copy: ${line}`;
  });
  localised.splice(
    settingsIndex,
    0,
    `require __DIR__ . '/wp-config-local.php';${lineEnding}`,
  );
  return localised.join("\n");
}

function urlVariants(home: string): string[] {
  const host = new URL(home).host.replace(/^www\./, "");
  return [
    `https://${host}`,
    `http://${host}`,
    `https://www.${host}`,
    `http://www.${host}`,
  ];
}

function configRequires(configText: string): string[] {
  const pattern =
    /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__|dirname\(\s*__FILE__\s*\)|ABSPATH)\s*\.\s*['"]\/?([^'"]+)['"]/g;
  return configText
    .matchAll(pattern)
    .map((match) => match[1] ?? "")
    .toArray();
}

function checksumWarnings(): string[] {
  const result = run("docker", [
    "compose",
    "run",
    "--rm",
    "-T",
    "cli",
    "wp",
    "core",
    "verify-checksums",
    "--skip-plugins",
    "--skip-themes",
  ]);
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("Warning: ") && !line.endsWith(": wp-config-local.php"),
    );
}

function repairCore(keep: readonly string[]): string[] {
  const version = wp(["core", "version"]);
  const locale = /\$wp_local_package\s*=\s*'([^']+)'/.exec(
    readFileSync(
      path.join(stackFolder, "site/wp-includes/version.php"),
      "utf8",
    ),
  )?.[1];
  wp([
    "core",
    "download",
    "--force",
    "--skip-content",
    `--version=${version}`,
    ...(locale === undefined ? [] : [`--locale=${locale}`]),
  ]);
  const removed: string[] = [];
  for (const warning of checksumWarnings()) {
    const file = /^Warning: File should not exist: (.+)$/.exec(warning)?.[1];
    if (file === undefined || keep.includes(file)) {
      continue;
    }
    rmSync(path.join(stackFolder, "site", file), { force: true });
    removed.push(file);
  }
  return removed;
}

function disableDiskPageCache(): string | undefined {
  const configPath = path.join(
    stackFolder,
    "site/wp-content/w3tc-config/master.php",
  );
  rmSync(path.join(stackFolder, "site/wp-content/cache"), {
    force: true,
    recursive: true,
  });
  if (!existsSync(configPath)) {
    return undefined;
  }
  const prefix = "<?php exit; ?>";
  const text = readFileSync(configPath, "utf8");
  if (!text.startsWith(prefix)) {
    fail(
      "site/wp-content/w3tc-config/master.php isn't in the expected format; turn its page cache off by hand",
    );
  }
  const settings = JSON.parse(text.slice(prefix.length)) as Record<
    string,
    unknown
  >;
  settings["pgcache.enabled"] = false;
  writeFileSync(configPath, prefix + JSON.stringify(settings, null, 4));
  return "W3 Total Cache: page cache off (it serves its disk cache through .htaccess without PHP)";
}

async function proveLogging(services: readonly WebService[]): Promise<void> {
  const probePath = path.join(
    stackFolder,
    "site/wp-content/mu-plugins/logging-probe.php",
  );
  const token = `logging probe ${randomUUID()}`;
  const createdFolder = mkdirSync(path.dirname(probePath), { recursive: true });
  writeFileSync(
    probePath,
    `<?php\ntrigger_error( '${token}', E_USER_NOTICE );\n`,
  );
  try {
    for (const service of services) {
      await fetch(`http://localhost:${service.port}/`, { redirect: "manual" });
      const logPath = path.join(service.logFolder, "debug.log");
      if (
        !existsSync(logPath) ||
        !readFileSync(logPath, "utf8").includes(token)
      ) {
        fail(
          `${service.name} (:${service.port}) didn't log the planted notice to ${logPath}`,
        );
      }
      report(`logging: ${service.name} on :${service.port} writes ${logPath}`);
    }
  } finally {
    rmSync(probePath, { force: true });
    if (createdFolder !== undefined) {
      rmSync(createdFolder, { force: true, recursive: true });
    }
  }
}

const { values: options } = parseArgs({
  options: {
    apply: { default: false, type: "boolean" },
    help: { default: false, type: "boolean" },
    "repair-core": { default: false, type: "boolean" },
    snapshot: { type: "string" },
    uploads: { type: "string" },
  },
});

if (options.help) {
  console.log(usage);
  process.exit(0);
}
if (options.snapshot === undefined) {
  fail(`pass --snapshot <snapshot folder>\n${usage}`);
}
const snapshot = path.resolve(options.snapshot);
const snapshotSite = path.join(snapshot, "site");
const snapshotDump = path.join(snapshot, "db.sql.gz");
const uploads =
  options.uploads === undefined ? undefined : path.resolve(options.uploads);
if (
  !existsSync(path.join(snapshotSite, "wp-config.php")) ||
  !existsSync(snapshotDump)
) {
  fail(`${snapshot} needs site/wp-config.php and db.sql.gz`);
}
if (uploads !== undefined && !existsSync(uploads)) {
  fail(`${uploads} doesn't exist`);
}
if (!existsSync(path.join(stackFolder, "wp-config-local.php"))) {
  fail("run from the stack folder (sites/<name>/local/)");
}

const compose = readCompose();
const services = webServices(compose);
const current = services.find((service) => service.name === "current");
if (current === undefined || services.length < 2) {
  fail(
    "compose.yaml needs a published `current` service and a `target` service, each with a /var/log/wordpress volume",
  );
}

let dump: DumpCheck;
try {
  dump = await inspectDump(snapshotDump);
} catch (error) {
  fail(`${snapshotDump} doesn't decompress: ${String(error)}`);
}
if (!dump.hasUtf8mb4Header || !dump.isComplete || dump.tableCount === 0) {
  fail(
    `${snapshotDump}: utf8mb4 header ${dump.hasUtf8mb4Header}, trailer ${dump.isComplete}, ${dump.tableCount} tables; take a verified dump first`,
  );
}

console.log(`Rebuild ${compose.name} from ${snapshot}`);
report(`dump: utf8mb4 header, trailer, ${dump.tableCount} tables`);
report(
  `stack: ${services.map((service) => `${service.name} on :${service.port}`).join(", ")}; content URLs point at :${current.port}`,
);
report(
  "discards: this stack's database volume, site/, logs/ and db/db.sql.gz; db/local-*.sql.gz and site-before/ stay",
);
report(
  `code: ${uploads === undefined ? "snapshot site/" : `snapshot site/ with uploads from ${uploads}`}, cache drop-ins left out`,
);
report(
  `core: ${options["repair-core"] ? "reinstalled at its own version, stray files removed" : "checksums reported only"}`,
);
if (!options.apply) {
  console.log("Dry run; pass --apply to rebuild");
  process.exit(0);
}

docker([
  "compose",
  "--profile",
  "cli",
  "--profile",
  "before",
  "down",
  "--volumes",
  "--remove-orphans",
]);
for (const entry of ["site", "logs", "db/db.sql.gz"]) {
  rmSync(path.join(stackFolder, entry), { force: true, recursive: true });
}

clone(snapshotSite, path.join(stackFolder, "site"));
const leftOut = cacheDropIns.filter((dropIn) =>
  existsSync(path.join(stackFolder, "site/wp-content", dropIn)),
);
for (const dropIn of leftOut) {
  rmSync(path.join(stackFolder, "site/wp-content", dropIn));
}
report(
  `left out: ${leftOut.length === 0 ? "no cache drop-ins present" : leftOut.join(", ")}`,
);
if (uploads !== undefined) {
  rmSync(path.join(stackFolder, "site/wp-content/uploads"), {
    force: true,
    recursive: true,
  });
  clone(uploads, path.join(stackFolder, "site/wp-content/uploads"));
}
const isFallbackMounted = Object.values(compose.services).some((service) =>
  service.volumes?.some(
    (volume) =>
      volume.target === "/etc/apache2/conf-enabled/uploads-fallback.conf",
  ),
);
const hasUploads = existsSync(
  path.join(stackFolder, "site/wp-content/uploads"),
);
if (hasUploads && isFallbackMounted) {
  report(
    "uploads: copied, yet the fallback is mounted, so a file missing from the copy loads from production; comment out its mounts in compose.yaml",
  );
}
if (!hasUploads && !isFallbackMounted) {
  report(
    "uploads: none copied and no fallback mounted, so media 404; pass --uploads, or uncomment the fallback mounts in compose.yaml",
  );
}
if (!hasUploads && isFallbackMounted) {
  report("uploads: none copied; the fallback serves them from production");
}

const configPath = path.join(stackFolder, "site/wp-config.php");
const liveConfig = readFileSync(configPath, "utf8");
writeFileSync(configPath, localiseConfig(liveConfig, localNames()));
writeFileSync(
  path.join(stackFolder, "site/wp-config-local.php"),
  readFileSync(path.join(stackFolder, "wp-config-local.php")),
);
const diskCache = disableDiskPageCache();

mkdirSync(path.join(stackFolder, "db"), { recursive: true });
clone(snapshotDump, path.join(stackFolder, "db/db.sql.gz"));
for (const service of services) {
  mkdirSync(service.logFolder, { recursive: true });
  // PHP writes the log as the web server's user, not the operator's
  chmodSync(service.logFolder, 0o777);
}

docker(["compose", "up", "--detach", "--wait", "--wait-timeout", "3600", "db"]);
const importedTables = Number(
  sql(
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()",
  ),
);
if (importedTables !== dump.tableCount) {
  fail(
    `the dump creates ${dump.tableCount} tables, the database holds ${importedTables}`,
  );
}
report(`import: ${importedTables} tables, matching the dump`);

must("docker", [
  "compose",
  "run",
  "--rm",
  "-T",
  "cli",
  "php",
  "-l",
  "/var/www/html/wp-config.php",
]);
// A missing or truncated core file fatals every load of WordPress, so core is settled before the first one
if (options["repair-core"]) {
  const removed = repairCore([
    ...configRequires(liveConfig),
    "wp-config-local.php",
  ]);
  report(
    `core: reinstalled; removed ${removed.length === 0 ? "nothing" : removed.join(", ")}`,
  );
}
const warnings = checksumWarnings();
report(`core checksums: ${warnings.length === 0 ? "clean" : "warnings below"}`);
for (const warning of warnings.slice(0, 20)) {
  report(`  ${warning}`);
}

if (wp(["eval", "echo is_multisite() ? 'yes' : 'no';"]) === "yes") {
  fail("multisite isn't covered by this template");
}

const home = wp(["option", "get", "home"]);
const localUrl = `http://localhost:${current.port}`;
for (const from of urlVariants(home)) {
  const replaceArguments = [
    "search-replace",
    from,
    localUrl,
    "--all-tables-with-prefix",
    "--skip-columns=guid",
  ];
  const found = Number(
    wp([...replaceArguments, "--dry-run", "--format=count"]),
  );
  if (found === 0) {
    continue;
  }
  wp([...replaceArguments, "--report-changed-only"]);
  const left = Number(wp([...replaceArguments, "--dry-run", "--format=count"]));
  if (left !== 0) {
    fail(`${from} still occurs ${left} times after search-replace`);
  }
  report(`urls: ${from} replaced with ${localUrl} (${found} found)`);
}

const prefixed = new Set(
  wp(["db", "tables", "--all-tables-with-prefix", "--format=csv"]).split(","),
);
const stray = wp(["db", "tables", "--all-tables", "--format=csv"])
  .split(",")
  .filter((table) => !prefixed.has(table));
report(
  `other table sets: ${stray.length === 0 ? "none" : `tables outside the prefix left as they are: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ` and ${stray.length - 5} more` : ""}`}`,
);

// The login scripts/smoke.ts uses against local targets
const localAdministrator = "localadmin";
const tameScript = readFileSync(
  path.join(import.meta.dirname, "rebuild-tame.php"),
  "utf8",
);
const tame = JSON.parse(
  wp(["eval-file", "-", localAdministrator], tameScript),
) as string[];
for (const change of [
  ...tame,
  ...(diskCache === undefined ? [] : [diskCache]),
]) {
  report(`tamed: ${change}`);
}

docker([
  "compose",
  "up",
  "--detach",
  "--wait",
  ...services.map((service) => service.name),
]);
await proveLogging(services);
console.log("rebuild complete");
