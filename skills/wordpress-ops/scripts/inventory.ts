import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ComponentKind,
  DirectoryRecord,
  Fetched,
  VulnerabilityRecord,
} from "./lookups.ts";

import {
  compareVersions,
  lookupDirectory,
  lookupVulnerabilities,
} from "./lookups.ts";

export interface OwnerRecord {
  owners: Record<string, string>;
  stamp: string;
}

export interface Manifest {
  active_theme: string;
  core: string;
  locale: string;
  parent_theme: string;
  php_cli: string;
  plugin_dir: string;
  plugins: {
    active: boolean;
    author: string;
    file: string;
    name: string;
    update_uri: string;
    version: string;
  }[];
  theme_root: string;
  themes: {
    author: string;
    slug: string;
    update_uri: string;
    version: string;
  }[];
  unlisted_active: {
    bytes: null | number;
    file: string;
    modified: null | string;
    state: string;
  }[];
}

export interface Component {
  author: string;
  directory: Fetched<DirectoryRecord>;
  isInUse: boolean;
  kind: ComponentKind;
  // Set when the wordpress.org account controlling releases differs from the previous scan's
  ownerChange: null | string;
  path: string;
  slug: string;
  updateUri: string;
  version: string;
  vulnerabilities: Fetched<VulnerabilityRecord>;
}

export function pluginSlug(file: string): string {
  return (file.split("/", 1)[0] ?? file)
    .replace(/\.disabled$/, "")
    .replace(/\.php$/, "");
}

// UpdraftPlus Premium 2.x.y.z tracks Free 1.x.y.z, and advisories cite only the Free numbers
export function comparableVersion(slug: string, version: string): string {
  if (slug === "updraftplus" && version.startsWith("2."))
    return `1.${version.slice(2)}`;
  return version;
}

function majorMinor(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function yearsSince(date: string): number {
  return (Date.now() - Date.parse(date)) / (365.25 * 24 * 3600 * 1000);
}

function areAuthorsDifferent(installed: string, listed: string): boolean {
  const left = installed.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const right = listed.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    left !== "" &&
    right !== "" &&
    !left.includes(right) &&
    !right.includes(left)
  );
}

// The tripwire for a release from a new owner: plugins expose only the owning account, themes also their header's Author
function authorChange(component: Component): null | string {
  if (component.ownerChange)
    return `wordpress.org owner changed: ${component.ownerChange}`;
  if (!component.directory.isOk || component.directory.value.state !== "listed")
    return null;
  const listedAuthor = component.directory.value.headerAuthor;
  if (
    listedAuthor === null ||
    !areAuthorsDifferent(component.author, listedAuthor)
  )
    return null;
  return `author differs: installed "${component.author}", wordpress.org "${listedAuthor}"`;
}

export function inventoryFlags(
  component: Component,
  latestCore: null | string,
): string[] {
  const flags: string[] = [];
  if (component.kind === "plugin" && component.path.endsWith(".php"))
    flags.push("single file");
  if (component.updateUri) flags.push(`Update URI ${component.updateUri}`);
  if (!component.directory.isOk)
    return [...flags, "wordpress.org lookup failed"];

  const record = component.directory.value;
  if (record.state === "absent") return [...flags, "not on wordpress.org"];
  if (record.state === "closed")
    return [
      ...flags,
      `**closed on wordpress.org** ${record.closedDate ?? ""} (${record.reason || "no reason given"})`,
    ];
  if (record.lastUpdated && yearsSince(record.lastUpdated) > 2)
    flags.push(
      `no release in ${yearsSince(record.lastUpdated) > 4 ? 4 : 2} years (last ${record.lastUpdated})`,
    );
  if (
    latestCore &&
    record.tested &&
    compareVersions(majorMinor(record.tested), majorMinor(latestCore)) < 0
  )
    flags.push(`tested up to ${record.tested}`);
  const change = authorChange(component);
  if (change) flags.push(`**${change}**`);
  return flags;
}

// Themes have no published checksums, so no theme is vouched for
export function isVouchedFor(
  component: Component,
  isVerified: boolean,
): boolean {
  if (!isVerified || component.kind !== "plugin" || !component.directory.isOk)
    return false;
  const record = component.directory.value;
  if (record.state !== "listed" || !record.lastUpdated) return false;
  return (
    yearsSince(record.lastUpdated) <= 2 && authorChange(component) === null
  );
}

export async function previousOwners(
  reports: string,
): Promise<null | OwnerRecord> {
  let entries: string[];
  try {
    entries = await readdir(reports);
  } catch {
    return null;
  }
  const sidecars = entries
    .filter((file) => /^scan-.+\.json$/.test(file))
    .toSorted((left, right) => left.localeCompare(right));
  const latest = sidecars.at(-1);
  if (!latest) return null;
  const parsed = JSON.parse(
    await readFile(path.join(reports, latest), "utf8"),
  ) as {
    owners?: Record<string, string>;
  };
  return {
    owners: parsed.owners ?? {},
    stamp: latest.slice("scan-".length, -".json".length),
  };
}

export function ownerKey(kind: ComponentKind, slug: string): string {
  return `${kind}:${slug}`;
}

function ownerChange(
  previous: null | OwnerRecord,
  key: string,
  directory: Fetched<DirectoryRecord>,
): null | string {
  const before = previous?.owners[key];
  if (
    !previous ||
    !before ||
    !directory.isOk ||
    directory.value.state !== "listed" ||
    directory.value.owner === before
  )
    return null;
  return `${before} at scan ${previous.stamp}, ${directory.value.owner} now`;
}

export async function gatherComponents(
  manifest: Manifest,
  previous: null | OwnerRecord,
): Promise<Component[]> {
  const plugins = manifest.plugins.map(async (plugin): Promise<Component> => {
    const slug = pluginSlug(plugin.file);
    const folder = plugin.file.includes("/")
      ? (plugin.file.split("/", 1)[0] ?? plugin.file)
      : plugin.file;
    // Core bundles Hello Dolly as a single file whose directory slug differs
    const listedSlug = slug === "hello" ? "hello-dolly" : slug;
    const [directory, vulnerabilities] = await Promise.all([
      lookupDirectory("plugin", listedSlug),
      lookupVulnerabilities("plugin", listedSlug),
    ]);
    const change = ownerChange(previous, ownerKey("plugin", slug), directory);
    return {
      author: plugin.author,
      directory,
      isInUse: plugin.active,
      kind: "plugin",
      ownerChange: change,
      path: `${manifest.plugin_dir}/${folder}`,
      slug,
      updateUri: plugin.update_uri,
      version: plugin.version,
      vulnerabilities,
    };
  });
  const themes = manifest.themes.map(async (theme): Promise<Component> => {
    const [directory, vulnerabilities] = await Promise.all([
      lookupDirectory("theme", theme.slug),
      lookupVulnerabilities("theme", theme.slug),
    ]);
    const isInUse =
      theme.slug === manifest.active_theme ||
      theme.slug === manifest.parent_theme;
    const change = ownerChange(
      previous,
      ownerKey("theme", theme.slug),
      directory,
    );
    return {
      author: theme.author,
      directory,
      isInUse,
      kind: "theme",
      ownerChange: change,
      path: `${manifest.theme_root}/${theme.slug}`,
      slug: theme.slug,
      updateUri: theme.update_uri,
      version: theme.version,
      vulnerabilities,
    };
  });
  return Promise.all([...plugins, ...themes]);
}
