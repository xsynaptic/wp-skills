import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SiteContext } from "./config.ts";
import type { KeyedIndicator, PackHit } from "./indicators.ts";
import type { Manifest } from "./inventory.ts";
import type { Vulnerability } from "./lookups.ts";
import type { Remote } from "./remote.ts";

import {
  hasFlag,
  loadWorkspace,
  selectSites,
  siteDirectory,
  timestamp,
} from "./config.ts";
import {
  corroborate,
  loadIndicators,
  nameStem,
  normalizeObject,
  ofKind,
} from "./indicators.ts";
import {
  comparableVersion,
  gatherComponents,
  inventoryFlags,
  isVouchedFor,
  ownerKey,
  pluginSlug,
  previousOwners,
} from "./inventory.ts";
import {
  isAffected,
  lookupCoreAdvisories,
  lookupKnownExploited,
  lookupLatestCore,
  lookupVulnerabilities,
} from "./lookups.ts";
import { connect, lastJsonLine } from "./remote.ts";
import {
  parseUpdates,
  summarizeCoreChecksums,
  unverifiedPlugins,
} from "./wp-cli-output.ts";

const usage = "usage: node scan.ts [site...]";
const recentRegistrationDays = 60;
const recentChangeDays = 14;

interface FlaggedUser {
  application_passwords: {
    created: null | string;
    last_used: null | string;
    name: string;
  }[];
  direct_caps: string[];
  email: string;
  is_recent: boolean;
  is_super_admin: boolean;
  login: string;
  newest_login: null | string;
  registered: string;
  risky_caps: string[];
  roles: string[];
  sessions: number;
}

interface Database {
  code_options: {
    bytes: number;
    is_transient: boolean;
    markers: string[];
    name: string;
    table: string;
  }[];
  cron_hooks: { hook: string; next: string; schedules: string[] }[];
  name_hits: { key: string; login?: string; name: string; table: string }[];
  options_tables: string[];
  prefix: string;
}

interface TriageHit {
  count: number;
  examples?: string[];
  lines?: number[];
  severity: "high" | "review";
}

interface FileEntry {
  bytes: number;
  is_config?: boolean;
  is_core_name?: boolean;
  modified: string;
  path: string;
  reason?: string;
  triage: null | Record<string, TriageHit>;
}

interface Files {
  above_docroot: FileEntry[];
  components: Record<
    string,
    { files: number; hits: Record<string, TriageHit> }
  >;
  config_tail: { line: number; text: string }[];
  directives: { line: number; path: string; text: string }[];
  dropins: FileEntry[];
  file_string_hits: { key: string; path: string }[];
  logs_failed: string[];
  logs_read: number;
  mu_plugins: FileEntry[];
  outside_wordpress: FileEntry[];
  recent_php: { count: number; newest: { modified: string; path: string }[] };
  request_hits: { count: number; examples: string[]; key: string }[];
  root_php: FileEntry[];
  unreferenced_hooks: string[];
  uploads_php: FileEntry[];
  walked: { bytes: number; files: number; unread: string[] };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

function triageSummary(triage: null | Record<string, TriageHit>): string {
  if (triage === null) return "not read (too large or unreadable)";
  const entries = Object.entries(triage);
  if (entries.length === 0) return "no triage pattern";
  const format = (severity: string) =>
    entries
      .filter(([, hit]) => hit.severity === severity)
      .map(
        ([label, hit]) =>
          `${label} ×${hit.count}${hit.lines ? ` (line ${hit.lines.join(", ")})` : ""}`,
      )
      .join("; ");
  return [format("high"), format("review") && `review: ${format("review")}`]
    .filter(Boolean)
    .join("; ");
}

function hasHighHit(triage: null | Record<string, TriageHit>): boolean {
  return Object.values(triage ?? {}).some((hit) => hit.severity === "high");
}

function formatVulnerability(
  vulnerability: Vulnerability,
  knownExploited: Set<string>,
): string {
  const reference =
    vulnerability.source.find((source) => source.id.startsWith("CVE")) ??
    vulnerability.source[0];
  const name = vulnerability.name
    .replaceAll(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"');
  const exploited =
    reference && knownExploited.has(reference.id) ? " **in CISA KEV**" : "";
  return reference
    ? `${name} ([${reference.id}](${reference.link}))${exploited}`
    : name;
}

async function readHelper(name: string): Promise<string> {
  return readFile(new URL(`php/${name}`, import.meta.url), "utf8");
}

async function scanSite(
  context: SiteContext,
  indicators: KeyedIndicator[],
  reports: string,
): Promise<{
  headline: string[];
  markdown: string;
  owners: Record<string, string>;
}> {
  const remote: Remote = connect(context);
  const previous = await previousOwners(reports);
  const nameIndicators = ofKind(indicators, [
    "option-name",
    "cron-hook",
    "user-login",
    "user-email",
  ]);
  const [manifestHelper, accountsHelper, databaseHelper] = await Promise.all([
    readHelper("manifest.php"),
    readHelper("accounts.php"),
    readHelper("database.php"),
  ]);
  const databaseInput = encode({
    indicators: nameIndicators.map(({ indicator, key }) => ({
      key,
      kind: indicator.kind,
      value: indicator.value,
    })),
  });
  const [
    manifest,
    accounts,
    database,
    coreChecksums,
    pluginChecksums,
    updates,
  ] = await Promise.all([
    remote.php<Manifest>(manifestHelper),
    remote.php<{ flagged: FlaggedUser[]; total: number }>(accountsHelper, [
      String(recentRegistrationDays),
    ]),
    remote.php<Database>(databaseHelper, [databaseInput]),
    remote.run(`${remote.wpCommand(["core", "verify-checksums"])} 2>&1`),
    remote.wp(["plugin", "verify-checksums", "--all", "--format=json"]),
    remote.run(
      `${remote.wpCommand(["plugin", "list", "--fields=name,update_version", "--format=json"])} 2>/dev/null; echo; ${remote.wpCommand(["theme", "list", "--fields=name,update_version", "--format=json"])} 2>/dev/null`,
    ),
  ]);

  const [
    components,
    latestCore,
    coreAdvisories,
    coreRecord,
    knownExploitedFetched,
  ] = await Promise.all([
    gatherComponents(manifest, previous),
    lookupLatestCore(),
    lookupCoreAdvisories(manifest.core),
    lookupVulnerabilities("core", manifest.core),
    lookupKnownExploited(),
  ]);
  const knownExploited = knownExploitedFetched.isOk
    ? knownExploitedFetched.value
    : new Set<string>();
  const failures: string[] = [];
  for (const fetched of [
    latestCore,
    coreAdvisories,
    coreRecord,
    knownExploitedFetched,
    ...components.flatMap((component) => [
      component.directory,
      component.vulnerabilities,
    ]),
  ]) {
    if (!fetched.isOk) failures.push(fetched.error);
  }

  const unlistedOnDisk = manifest.unlisted_active
    .filter((entry) => entry.state !== "missing")
    .map(
      (entry) =>
        `${manifest.plugin_dir}/${entry.file.split("/", 1)[0] ?? entry.file}`,
    );
  const mismatches = pluginChecksums.stdout.trimStart().startsWith("[")
    ? (lastJsonLine(pluginChecksums.stdout, "plugin verify-checksums") as {
        file: string;
        message: string;
        plugin_name: string;
      }[])
    : [];
  const unverified = unverifiedPlugins(
    mismatches.map((mismatch) => mismatch.plugin_name),
    pluginChecksums.stderr,
    pluginChecksums.exitCode === 0 || mismatches.length > 0,
  );
  const triageTargets = [
    ...new Set([
      ...components
        .filter(
          (component) =>
            !isVouchedFor(
              component,
              unverified !== null && !unverified.has(component.slug),
            ),
        )
        .map((component) => component.path),
      ...unlistedOnDisk,
    ]),
  ];
  const files = await remote.php<Files>(await readHelper("files.php"), [
    encode({
      fileStrings: ofKind(indicators, ["file-string"]).map(
        ({ indicator, key }) => ({
          key,
          match: indicator.match,
          roots: indicator.roots,
          value: indicator.value,
        }),
      ),
      hooks: database.cron_hooks.map(({ hook }) => hook),
      logRoot: context.site.logRoot ?? null,
      recentDays: recentChangeDays,
      requests: ofKind(indicators, ["request"]).map(({ indicator, key }) => ({
        key,
        method: indicator.method,
        path: indicator.path,
        responseBytes: indicator.responseBytes ?? null,
        userAgent: indicator.userAgent,
      })),
      triage: triageTargets,
    }),
  ]);
  if (files.logs_failed.length > 0)
    failures.push(`unreadable logs: ${files.logs_failed.join(", ")}`);

  const headline: string[] = [];
  const lines: string[] = [];
  const latest = latestCore.isOk ? latestCore.value : null;
  const theme =
    manifest.parent_theme === manifest.active_theme
      ? manifest.active_theme
      : `${manifest.active_theme} (parent ${manifest.parent_theme})`;
  lines.push(
    `# Scan of ${context.name} (${context.site.url})`,
    "",
    `WordPress ${manifest.core}${latest ? ` (latest ${latest})` : ""}, CLI PHP ${manifest.php_cli}, theme \`${theme}\`, via ${remote.label}`,
    "",
    "## Core",
    "",
  );
  if (coreAdvisories.isOk) {
    const matched = coreAdvisories.value.matched;
    const exploited = matched.filter(
      (advisory) => advisory.cve && knownExploited.has(advisory.cve),
    );
    if (matched.length > 0) {
      const critical = matched.filter(
        (advisory) =>
          advisory.severity === "critical" || exploited.includes(advisory),
      );
      headline.push(
        `core ${manifest.core}: ${matched.length} project advisories, ${exploited.length} in CISA KEV${critical.length > 0 ? `: ${critical.map((advisory) => `${advisory.cve ?? advisory.ghsa} (${advisory.severity}, fixed in ${advisory.patched})`).join("; ")}` : ""}`,
      );
    }
    lines.push(
      "| Advisory | CVE | Severity | Fixed in | KEV | Summary |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const advisory of matched) {
      lines.push(
        `| ${advisory.ghsa} | ${advisory.cve ?? ""} | ${advisory.severity} | ${advisory.patched} | ${advisory.cve && knownExploited.has(advisory.cve) ? "yes" : ""} | ${cell(advisory.summary)} |`,
      );
    }
    if (matched.length === 0) lines.push("| none | | | | | |");
    if (coreAdvisories.value.unparsed.length > 0)
      lines.push(
        "",
        `Ranges not parsed (pre-releases and prose): ${coreAdvisories.value.unparsed.length}`,
      );
  }
  if (coreRecord.isOk)
    lines.push(
      "",
      `WPVulnerability lists ${coreRecord.value.vulnerabilities.length} entries for core ${manifest.core}; it misses some project advisories, so the table above is the authority.`,
    );
  const coreSummary = summarizeCoreChecksums(coreChecksums.stdout);
  if (coreSummary.isUnavailable)
    failures.push(
      `core checksums: ${coreChecksums.stdout.trim().split("\n").at(-1)?.slice(0, 200) ?? "no output"}`,
    );
  if (coreSummary.flags.length > 0)
    headline.push(`core files: ${coreSummary.flags.join(", ")}`);
  lines.push(
    "",
    "```",
    coreChecksums.stdout.trim().split("\n").slice(0, 40).join("\n"),
    "```",
    "",
  );

  const updateVersions = parseUpdates(updates.stdout);
  for (const kind of ["plugin", "theme"] as const) {
    lines.push(
      `## ${kind === "plugin" ? "Plugins" : "Themes"}`,
      "",
      `| ${kind === "plugin" ? "Plugin" : "Theme"} | Version | In use | Update to | Flags | Vulnerabilities |`,
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const component of components) {
      if (component.kind !== kind) continue;
      const flags = inventoryFlags(component, latest);
      const affected = component.vulnerabilities.isOk
        ? component.vulnerabilities.value.vulnerabilities.filter(
            (vulnerability) =>
              isAffected(
                comparableVersion(component.slug, component.version),
                vulnerability.operator,
              ),
          )
        : [];
      const updateTo =
        updateVersions.get(
          kind === "plugin"
            ? (component.path.split("/").at(-1) ?? "").replace(/\.php$/, "")
            : component.slug,
        ) ?? "";
      lines.push(
        `| ${component.slug} | ${component.version} | ${component.isInUse ? "yes" : "no"} | ${updateTo} | ${cell(flags.join("; "))} | ${cell(affected.map((vulnerability) => formatVulnerability(vulnerability, knownExploited)).join("; "))} |`,
      );
      const where = `${kind} ${component.slug} ${component.version}${component.isInUse ? "" : " (not in use)"}`;
      if (affected.length > 0)
        headline.push(
          `${where}: ${affected.length} known vulnerabilit${affected.length === 1 ? "y" : "ies"}${affected.some((vulnerability) => vulnerability.source.some((source) => knownExploited.has(source.id))) ? ", some in CISA KEV" : ""}`,
        );
      for (const flag of flags) {
        if (flag.startsWith("**"))
          headline.push(`${where}: ${flag.replaceAll("**", "")}`);
      }
    }
    lines.push("");
  }

  lines.push("## Active plugins against disk", "");
  if (manifest.unlisted_active.length === 0)
    lines.push("Every `active_plugins` entry has a plugin header on disk.");
  for (const entry of manifest.unlisted_active) {
    const description = `active plugin \`${entry.file}\` is ${entry.state}${entry.bytes === null ? "" : ` (${entry.bytes} bytes, modified ${entry.modified})`}; get_plugins() and the Plugins screen don't list it`;
    lines.push(`- ${description}`);
    headline.push(description);
  }
  lines.push("");

  const loose: [string, FileEntry[]][] = [
    ["mu-plugin", files.mu_plugins],
    ["drop-in", files.dropins],
    [
      "root-level PHP",
      files.root_php.filter((entry) => !entry.is_core_name && !entry.is_config),
    ],
    ["PHP above the docroot", files.above_docroot],
  ];
  lines.push(
    "## mu-plugins, drop-ins and PHP outside the plugin folders",
    "",
    "Each loads or answers without activation. Read every one.",
    "",
    "| Kind | Path | Bytes | Modified | Triage |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [kind, entries] of loose) {
    for (const entry of entries) {
      lines.push(
        `| ${kind} | \`${entry.path}\` | ${entry.bytes} | ${entry.modified} | ${cell(triageSummary(entry.triage))} |`,
      );
      headline.push(
        `${kind} \`${entry.path}\` (${entry.bytes} B, ${entry.modified.slice(0, 10)}): ${triageSummary(entry.triage)}`,
      );
    }
  }
  const config = files.root_php.find((entry) => entry.is_config);
  if (config) {
    lines.push(
      `| config | \`${config.path}\` | ${config.bytes} | ${config.modified} | ${cell(triageSummary(config.triage))} |`,
    );
    if (hasHighHit(config.triage))
      headline.push(`\`${config.path}\`: ${triageSummary(config.triage)}`);
  }
  lines.push("");
  if (files.config_tail.length > 0) {
    lines.push(
      "Code after the `wp-settings.php` require in `wp-config.php` (strings replaced by their lengths):",
      "",
      "```",
      ...files.config_tail.map(({ line, text }) => `${line}: ${text}`),
      "```",
      "",
    );
    headline.push(
      `wp-config.php: ${files.config_tail.length} line${files.config_tail.length === 1 ? "" : "s"} after the wp-settings.php require (from line ${files.config_tail[0]?.line})`,
    );
  }
  if (files.directives.length > 0) {
    lines.push(
      "PHP and handler directives in `.user.ini` and `.htaccess` files:",
      "",
      ...files.directives.map(
        ({ line, path: file, text }) => `- \`${file}:${line}\` ${text}`,
      ),
      "",
    );
    for (const directive of files.directives)
      headline.push(
        `\`${directive.path}:${directive.line}\`: ${directive.text}`,
      );
  }

  lines.push("## Code in uploads", "");
  if (files.uploads_php.length === 0)
    lines.push(
      "No file in uploads has a code extension or a PHP tag in its first 4 KB.",
    );
  for (const entry of files.uploads_php)
    lines.push(
      `- \`${entry.path}\` (${entry.reason}, ${entry.bytes} B, ${entry.modified}): ${triageSummary(entry.triage)}`,
    );
  if (files.uploads_php.length > 0)
    headline.push(
      `code in uploads: ${files.uploads_php.length} (${files.uploads_php
        .slice(0, 5)
        .map((entry) => entry.path)
        .join(", ")}${files.uploads_php.length > 5 ? ", …" : ""})`,
    );
  lines.push(
    "",
    "## Code outside WordPress's folders",
    "",
    "Code files and scripts in docroot folders other than `wp-admin`, `wp-includes` and `wp-content`: served from the same PHP pool, and covered by no checksum or component triage. Read every file with a high hit, and ask the owner what each folder is for.",
    "",
  );
  const outsideFolders = Map.groupBy(
    files.outside_wordpress,
    (entry) => entry.path.split("/", 1)[0] ?? entry.path,
  );
  if (outsideFolders.size === 0) lines.push("None.");
  for (const [folder, entries] of outsideFolders) {
    const newest =
      entries
        .map((entry) => entry.modified)
        .toSorted((left, right) => left.localeCompare(right))
        .at(-1) ?? "";
    const flagged = entries.filter((entry) => hasHighHit(entry.triage));
    lines.push(
      `- \`${folder}/\`: ${entries.length} file${entries.length === 1 ? "" : "s"}, newest ${newest}${flagged.length > 0 ? `; high hits in ${flagged.length}` : ""}`,
    );
    for (const entry of flagged)
      lines.push(
        `  - \`${entry.path}\` (${entry.bytes} B, ${entry.modified}): ${triageSummary(entry.triage)}`,
      );
    headline.push(
      `code outside WordPress's folders: \`${folder}/\` holds ${entries.length} file${entries.length === 1 ? "" : "s"}${
        flagged.length > 0
          ? `, ${flagged.length} with high triage hits (${flagged
              .slice(0, 3)
              .map((entry) => entry.path)
              .join(", ")}${flagged.length > 3 ? ", …" : ""})`
          : ""
      }`,
    );
  }
  lines.push(
    "",
    "## Code triage of components nothing vouches for",
    "",
    "Every theme, and every plugin except maintained wordpress.org releases (updated within two years, under their listed author) whose files match the release's checksums. Pattern hits are leads for reading, not verdicts; a component without hits is still unread. What wasn't read: the vouched-for plugins, and any file over 8 MB.",
    "",
  );
  for (const target of triageTargets) {
    const component = files.components[target];
    const summary = component
      ? Object.entries(component.hits).map(
          ([label, hit]) =>
            `${label} ×${hit.count} (${(hit.examples ?? []).join(", ")})`,
        )
      : [];
    lines.push(
      `- \`${target}\` (${component?.files ?? 0} PHP files): ${summary.join("; ") || "no triage pattern"}`,
    );
    const high = component
      ? Object.entries(component.hits).filter(
          ([, hit]) => hit.severity === "high",
        )
      : [];
    if (high.length > 0)
      headline.push(
        `\`${target}\` (unvouched code): ${high.map(([label, hit]) => `${label} ×${hit.count}`).join(", ")}`,
      );
  }
  if (triageTargets.length === 0)
    lines.push("- none: every component is a vouched-for wordpress.org plugin");
  lines.push("", "## Plugin file integrity (wordpress.org plugins only)", "");
  if (mismatches.length === 0)
    lines.push(
      pluginChecksums.exitCode === 0
        ? "No mismatches."
        : "No mismatch list; see the command's messages below.",
    );
  for (const mismatch of mismatches)
    lines.push(
      `- \`${mismatch.plugin_name}/${mismatch.file}\`: ${mismatch.message}`,
    );
  const skipped =
    pluginChecksums.stderr.match(/Could not retrieve the checksums/g)?.length ??
    0;
  if (skipped > 0)
    lines.push(
      "",
      `${skipped} plugins skipped (no published checksums: premium, custom, or wordpress.org unreachable).`,
    );
  const messages = pluginChecksums.stderr
    .trim()
    .split("\n")
    .filter(
      (line) =>
        line !== "" && !line.includes("Could not retrieve the checksums"),
    );
  if (messages.length > 0) lines.push("", "```", ...messages.slice(-8), "```");
  if (
    /cURL error|Could not resolve|Failed to connect/i.test(
      pluginChecksums.stderr,
    )
  )
    failures.push("plugin checksums: wordpress.org unreachable");
  // Core bundles its own hello.php, which differs from the wordpress.org copy only by a text domain
  const changedPlugins = new Set(
    mismatches
      .map((mismatch) => mismatch.plugin_name)
      .filter((name) => name !== "hello"),
  );
  if (changedPlugins.size > 0)
    headline.push(
      `modified files in wordpress.org plugins: ${[...changedPlugins].join(", ")}`,
    );
  lines.push(
    "",
    `## Users with powerful capabilities, registered in the last ${recentRegistrationDays} days, or holding application passwords (${accounts.flagged.length} of ${accounts.total})`,
    "",
    "| Login | Email | Registered | Roles | Risky caps | Direct caps | App passwords | Sessions (newest login) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const user of accounts.flagged) {
    const passwords = user.application_passwords
      .map(
        (password) =>
          `${password.name} (created ${password.created ?? "?"}, used ${password.last_used ?? "never"})`,
      )
      .join("; ");
    lines.push(
      `| ${cell(user.login)} | ${cell(user.email)} | ${user.registered} | ${user.roles.join(", ")}${user.is_super_admin ? ", super admin" : ""} | ${user.risky_caps.join(", ")} | ${user.direct_caps.join(", ")} | ${cell(passwords)} | ${user.sessions} (${user.newest_login ?? "none"}) |`,
    );
    if (user.direct_caps.length > 0)
      headline.push(
        `user ${user.login} holds capabilities directly, outside any role: ${user.direct_caps.join(", ")}`,
      );
    if (user.is_recent && user.risky_caps.length > 0)
      headline.push(
        `powerful user ${user.login} registered ${user.registered}`,
      );
    if (user.application_passwords.length > 0)
      headline.push(
        `user ${user.login} has ${user.application_passwords.length} application password${user.application_passwords.length === 1 ? "" : "s"}: ${passwords}`,
      );
  }
  lines.push("");

  const tables = database.options_tables.filter(
    (table) => table !== `${database.prefix}options`,
  );
  lines.push(
    "## Options holding code markers",
    "",
    ...(tables.length > 0
      ? [
          `Other options tables searched (a second install shares this database): ${tables.join(", ")}`,
          "",
        ]
      : []),
    "| Table | Option | Bytes | Markers |",
    "| --- | --- | --- | --- |",
    ...database.code_options.map(
      (option) =>
        `| ${option.table} | ${cell(option.name)} | ${option.bytes} | ${cell(option.markers.join(", "))} |`,
    ),
    "",
  );
  const persistent = database.code_options.filter(
    (option) => !option.is_transient,
  );
  if (persistent.length > 0)
    headline.push(
      `options holding code markers: ${persistent
        .slice(0, 8)
        .map((option) => `${option.name} (${option.markers.join(", ")})`)
        .join(
          "; ",
        )}${persistent.length > 8 ? `; ${persistent.length - 8} more` : ""}`,
    );

  lines.push(
    "## Cron hooks no code file names",
    "",
    "WP-Cron fires these with nothing attached, or their name is built at runtime; a leftover from a removed plugin or implant looks like this.",
    "",
    ...(files.unreferenced_hooks.length > 0
      ? files.unreferenced_hooks.map((hook) => `- \`${hook}\``)
      : ["None."]),
    "",
  );
  if (files.unreferenced_hooks.length > 0)
    headline.push(
      `cron hooks no code file names: ${files.unreferenced_hooks.join(", ")}`,
    );

  const byKey = new Map(indicators.map((entry) => [entry.key, entry]));
  const unlistedSlugs = manifest.unlisted_active.map((entry) =>
    normalizeObject(pluginSlug(entry.file)),
  );
  const userSignals = accounts.flagged
    .filter((user) => user.direct_caps.length > 0 || user.is_recent)
    .map((user) => normalizeObject(user.login));
  // Off-repo alone corroborates nothing: every premium plugin is off-repo, and triage reads them all
  const signalled = new Set([...unlistedSlugs, ...userSignals]);
  const objectOfPath = (file: string) =>
    normalizeObject(
      file
        .replace(`${manifest.plugin_dir}/`, "")
        .replace(`${manifest.theme_root}/`, "")
        .split("/", 1)[0]
        ?.replace(/\.php$/, "") ?? file,
    );

  const packHits: PackHit[] = [];
  for (const { indicator, key } of ofKind(indicators, ["plugin-slug"])) {
    const pattern = new RegExp(indicator.value);
    const slugs = [
      ...new Set([
        ...manifest.plugins.map((plugin) => pluginSlug(plugin.file)),
        ...manifest.unlisted_active.map((entry) => pluginSlug(entry.file)),
      ]),
    ];
    for (const slug of slugs) {
      if (pattern.test(slug))
        packHits.push({
          key,
          object: normalizeObject(slug),
          subject: `plugin ${slug}`,
        });
    }
  }
  for (const hit of files.file_string_hits) {
    const indicator = byKey.get(hit.key)?.indicator;
    const value =
      indicator?.kind === "file-string" ? ` holds "${indicator.value}"` : "";
    packHits.push({
      key: hit.key,
      object: objectOfPath(hit.path),
      subject: `\`${hit.path}\`${value}`,
    });
  }
  for (const hit of database.name_hits) {
    const indicator = byKey.get(hit.key)?.indicator;
    const login =
      hit.login && hit.login !== hit.name ? ` (login ${hit.login})` : "";
    const label = `${indicator?.kind ?? "name"} ${hit.name}${login}`;
    const object = hit.login
      ? normalizeObject(hit.login)
      : nameStem(
          hit.name,
          indicator && "value" in indicator ? indicator.value : "",
        );
    packHits.push({ key: hit.key, object, subject: `${label} (${hit.table})` });
  }
  for (const hit of files.request_hits) {
    if (hit.key === "unlabelled") continue;
    packHits.push({
      key: hit.key,
      object: `request:${hit.key}`,
      subject: `${hit.count} log lines`,
    });
  }

  const { reported, uncorroborated } = corroborate(packHits, byKey, signalled);
  lines.push(
    "## Indicator packs",
    "",
    `Packs: ${[...new Set(indicators.map((entry) => entry.pack))].join(", ") || "none"}. Retained logs read: ${files.logs_read}.`,
    "",
  );
  for (const hit of reported) {
    const entry = byKey.get(hit.key);
    if (!entry) continue;
    lines.push(
      `- [${entry.pack}] ${entry.indicator.role}, ${entry.indicator.strength}: ${hit.subject}. ${entry.indicator.note}`,
    );
    const request = files.request_hits.find(
      (requestHit) => requestHit.key === hit.key,
    );
    if (request)
      lines.push(
        "",
        "  ```",
        ...request.examples.map((example) => `  ${example}`),
        "  ```",
        "",
      );
    headline.push(
      `[${entry.pack}] ${entry.indicator.role}${entry.indicator.kind === "request" ? ` ${entry.indicator.label}` : ""}${entry.indicator.strength === "weak" ? " (weak, corroborated)" : ""}: ${hit.subject}`,
    );
  }
  const unlabelled = files.request_hits.find(
    (entry) => entry.key === "unlabelled",
  );
  if (unlabelled) {
    lines.push(
      `- ${unlabelled.count} log lines match a request indicator's method, path and user agent at a reply size no indicator labels:`,
      "",
      "  ```",
      ...unlabelled.examples.map((example) => `  ${example}`),
      "  ```",
      "",
    );
    headline.push(
      `request indicators: ${unlabelled.count} log lines with a matching method, path and user agent at an unlabelled reply size`,
    );
  }
  if (uncorroborated > 0)
    lines.push(
      `- ${uncorroborated} weak hits with nothing on the same object to corroborate them; not listed`,
    );
  if (!unlabelled && reported.length === 0)
    lines.push(`- no reported hit${logsNote(context, files)}`);
  lines.push(
    "",
    `## PHP changed in the last ${recentChangeDays} days (${files.recent_php.count}; newest 20)`,
    "",
    ...files.recent_php.newest.map(
      (entry) => `- ${entry.modified} \`${entry.path}\``,
    ),
    "",
    "## Coverage",
    "",
    `${files.walked.files} PHP files read (${(files.walked.bytes / 1024 / 1024).toFixed(1)} MB).${files.walked.unread.length > 0 ? ` Not read: ${files.walked.unread.join(", ")}.` : ""}`,
    "",
  );

  if (failures.length > 0) {
    headline.unshift(
      `lookups failed, so their checks are unknown, not clean: ${failures.length} (see the report's last section)`,
    );
    lines.push(
      "## Lookups that failed",
      "",
      ...failures.map((failure) => `- ${failure}`),
      "",
    );
  }
  lines.splice(
    2,
    0,
    "## Headline",
    "",
    ...(headline.length > 0
      ? headline.map((line) => `- ${line}`)
      : ["- nothing flagged by these checks"]),
    "",
    packCoverage(indicators),
    "",
  );
  const owners: Record<string, string> = {};
  for (const component of components) {
    if (
      component.directory.isOk &&
      component.directory.value.state === "listed"
    )
      owners[ownerKey(component.kind, component.slug)] =
        component.directory.value.owner;
  }
  return { headline, markdown: lines.join("\n"), owners };
}

// A clean pack result says nothing about campaigns no pack describes
function packCoverage(indicators: readonly KeyedIndicator[]): string {
  const packs = [...new Set(indicators.map((entry) => entry.pack))];
  if (packs.length === 0)
    return "No indicator pack loaded, so no campaign's indicators were checked.";
  return `Indicator packs loaded: ${packs.join(", ")}. No hit from them covers those campaigns only.`;
}

function logsNote(context: SiteContext, files: Files): string {
  if (!context.site.logRoot)
    return "; no logRoot configured, so request indicators weren't checked";
  return files.logs_read === 0 ? "; no log file was readable" : "";
}

if (hasFlag("help")) {
  console.log(usage);
  process.exit(0);
}
const workspace = await loadWorkspace();
const indicators = await loadIndicators();
const stamp = timestamp();
let hasFailure = false;
for (const context of selectSites(workspace)) {
  try {
    const reports = path.join(siteDirectory(context), "reports");
    const { headline, markdown, owners } = await scanSite(
      context,
      indicators,
      reports,
    );
    await mkdir(reports, { recursive: true });
    const reportPath = path.join(reports, `scan-${stamp}.md`);
    await writeFile(reportPath, markdown);
    await writeFile(
      path.join(reports, `scan-${stamp}.json`),
      `${JSON.stringify({ owners }, null, "\t")}\n`,
    );
    console.log(
      `\n## ${context.name}\n\n${(headline.length > 0 ? headline : ["nothing flagged by these checks"]).map((line) => `- ${line}`).join("\n")}\n\n${packCoverage(indicators)}\nReport: ${path.relative(workspace.root, reportPath)}`,
    );
  } catch (error) {
    hasFailure = true;
    console.error(
      `${context.name}: SCAN FAILED`,
      error instanceof Error ? error.message : error,
    );
  }
}
process.exitCode = hasFailure ? 1 : 0;
