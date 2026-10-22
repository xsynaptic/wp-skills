import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The format is defined in ioc/README.md

type Role = "attack" | "entry" | "evidence" | "implant";
type FileRoot = "mu-plugins" | "plugins" | "root" | "themes" | "uploads";
type NameKind =
  "cron-hook" | "option-name" | "plugin-slug" | "user-email" | "user-login";

interface IndicatorBase {
  note: string;
  role: Role;
  strength: "strong" | "weak";
}

export interface FileStringIndicator extends IndicatorBase {
  kind: "file-string";
  match: "literal" | "regex";
  roots: FileRoot[];
  value: string;
}

export interface NameIndicator extends IndicatorBase {
  kind: NameKind;
  value: string;
}

export interface RequestIndicator extends IndicatorBase {
  kind: "request";
  label: string;
  method: string;
  path: string;
  requestBytes?: [number, number];
  responseBytes?: [number, number];
  userAgent: string;
}

export type Indicator = FileStringIndicator | NameIndicator | RequestIndicator;

interface IndicatorPack {
  id: string;
  indicators: Indicator[];
  sources: string[];
  technique: string;
  title: string;
  verified: string;
}

export interface KeyedIndicator<Kind extends Indicator = Indicator> {
  indicator: Kind;
  key: string;
  pack: string;
}

export interface PackHit {
  key: string;
  // The object the hit belongs to, for corroboration: a plugin slug, a name stem, or a login
  object: string;
  // What matched: a path, an option or hook name, a login, a plugin slug, or a request count
  subject: string;
}

const nameKinds = new Set<string>([
  "cron-hook",
  "option-name",
  "plugin-slug",
  "user-email",
  "user-login",
]);
const fileRoots = new Set<string>([
  "mu-plugins",
  "plugins",
  "root",
  "themes",
  "uploads",
]);
const strengths = new Set<string>(["strong", "weak"]);

function assertRegex(source: string, where: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(
      `${where}: invalid regular expression ${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validate(pack: IndicatorPack, file: string): void {
  if (`${pack.id}.json` !== path.basename(file))
    throw new Error(`${file}: id ${pack.id} doesn't match the file name`);
  if (!Array.isArray(pack.indicators))
    throw new TypeError(`${file}: no indicators list`);
  for (const [index, indicator] of pack.indicators.entries()) {
    const where = `${file} indicator ${index}`;
    if (!strengths.has(indicator.strength))
      throw new Error(`${where}: strength must be strong or weak`);
    if (indicator.kind === "file-string") {
      if (indicator.roots.some((root) => !fileRoots.has(root)))
        throw new Error(
          `${where}: unknown root in ${indicator.roots.join(", ")}`,
        );
      if (indicator.match === "regex") assertRegex(indicator.value, where);
      continue;
    }
    if (indicator.kind === "request") {
      assertRegex(indicator.userAgent, where);
      continue;
    }
    if (!nameKinds.has(indicator.kind))
      throw new Error(
        `${where}: unknown kind ${String((indicator as { kind: unknown }).kind)}`,
      );
    if (indicator.kind === "plugin-slug") assertRegex(indicator.value, where);
  }
}

export async function loadIndicators(): Promise<KeyedIndicator[]> {
  const directory = new URL("ioc/", import.meta.url);
  const entries = await readdir(directory);
  const files = entries
    .filter((file) => file.endsWith(".json"))
    .toSorted((left, right) => left.localeCompare(right));
  const keyed: KeyedIndicator[] = [];
  for (const file of files) {
    const pack = JSON.parse(
      await readFile(new URL(file, directory), "utf8"),
    ) as IndicatorPack;
    validate(pack, file);
    for (const [index, indicator] of pack.indicators.entries())
      keyed.push({ indicator, key: `${pack.id}#${index}`, pack: pack.id });
  }
  return keyed;
}

export function ofKind<Kind extends Indicator["kind"]>(
  indicators: KeyedIndicator[],
  kinds: readonly Kind[],
): KeyedIndicator<Indicator & { kind: Kind }>[] {
  return indicators.filter(
    (entry): entry is KeyedIndicator<Indicator & { kind: Kind }> =>
      (kinds as readonly string[]).includes(entry.indicator.kind),
  );
}

export function normalizeObject(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

// `%\_installed` on `lite_sweep_2_installed` yields the stem `lite-sweep-2`, which can name a plugin
export function nameStem(name: string, likeValue: string): string {
  const suffix = /^%((?:[^%_\\]|\\[%_\\])+)$/
    .exec(likeValue)?.[1]
    ?.replaceAll(/\\(.)/g, "$1");
  if (suffix && name.toLowerCase().endsWith(suffix.toLowerCase()))
    return normalizeObject(name.slice(0, name.length - suffix.length));
  return normalizeObject(name);
}

// Weak hits count only beside a strong hit on the same object, or one of the scan's own signals on it
export function corroborate(
  hits: PackHit[],
  indicators: Map<string, KeyedIndicator>,
  signalledObjects: Set<string>,
): { reported: PackHit[]; uncorroborated: number } {
  const strongObjects = new Set(
    hits
      .filter((hit) => indicators.get(hit.key)?.indicator.strength === "strong")
      .map((hit) => hit.object),
  );
  const reported: PackHit[] = [];
  let uncorroborated = 0;
  for (const hit of hits) {
    const isStrong = indicators.get(hit.key)?.indicator.strength === "strong";
    if (
      isStrong ||
      strongObjects.has(hit.object) ||
      signalledObjects.has(hit.object)
    )
      reported.push(hit);
    else uncorroborated++;
  }
  return { reported, uncorroborated };
}
