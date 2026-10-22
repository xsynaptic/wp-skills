// Every source here is keyless; a failed lookup is reported as unknown, never as clean

export type Fetched<Value> =
  { error: string; isOk: false } | { isOk: true; value: Value };

export type ComponentKind = "plugin" | "theme";

interface VulnerabilityOperator {
  max_operator: null | string;
  max_version: null | string;
  min_operator: null | string;
  min_version: null | string;
  unfixed: string;
}

export interface Vulnerability {
  name: string;
  operator: VulnerabilityOperator;
  source: { id: string; link: string }[];
}

export interface VulnerabilityRecord {
  isKnown: boolean;
  vulnerabilities: Vulnerability[];
}

export type DirectoryRecord =
  // `owner` is the wordpress.org account that controls releases; only themes report their header's Author too
  | { closedDate: null | string; reason: string; state: "closed" }
  | {
      headerAuthor: null | string;
      lastUpdated: null | string;
      owner: string;
      requiresPhp: null | string;
      state: "listed";
      tested: null | string;
      version: string;
    }
  | { state: "absent" };

export interface CoreAdvisory {
  cve: null | string;
  ghsa: string;
  patched: string;
  severity: string;
  summary: string;
}

const cache = new Map<string, Promise<Fetched<unknown>>>();

async function requestJson(
  url: string,
  headers: Record<string, string>,
): Promise<Fetched<{ body: unknown; status: number }>> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "wordpress-ops-scan", ...headers },
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    try {
      return {
        isOk: true,
        value: { body: JSON.parse(text), status: response.status },
      };
    } catch {
      return {
        error: `${url}: HTTP ${response.status}, not JSON`,
        isOk: false,
      };
    }
  } catch (error) {
    return {
      error: `${url}: ${error instanceof Error ? error.message : String(error)}`,
      isOk: false,
    };
  }
}

function cached<Value>(
  key: string,
  load: () => Promise<Fetched<Value>>,
): Promise<Fetched<Value>> {
  const existing = cache.get(key);
  if (existing) return existing as Promise<Fetched<Value>>;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

// PHP's version_compare ranks, which WordPress orders its own updates by; a numeric part ranks as `release`
const partRanks: Record<string, number> = {
  a: 1,
  alpha: 1,
  b: 2,
  beta: 2,
  dev: 0,
  p: 5,
  pl: 5,
  rc: 3,
};
const releaseRank = 4;
const unknownRank = -1;

function versionParts(version: string): string[] {
  return version.toLowerCase().match(/\d+|[a-z]+/g) ?? [];
}

function partRank(part: string): number {
  if (/^\d/.test(part)) return releaseRank;
  return partRanks[part] ?? unknownRank;
}

function comparePart(left: string, right: string): number {
  const leftRank = partRank(left);
  const rightRank = partRank(right);
  if (leftRank !== rightRank) return Math.sign(leftRank - rightRank);
  if (leftRank !== releaseRank) return 0;
  return Math.sign(Number(left) - Number(right));
}

// Unlike PHP, a missing part reads as 0, so 7.1 equals the 7.1.0 that advisories name and still follows 7.1-RC1
export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = comparePart(
      leftParts[index] ?? "0",
      rightParts[index] ?? "0",
    );
    if (difference !== 0) return difference;
  }
  return 0;
}

function isSatisfied(
  version: string,
  operator: string,
  bound: string,
): boolean {
  const comparison = compareVersions(version, bound);
  switch (operator) {
    case "<":
    case "lt": {
      return comparison < 0;
    }
    case "<=":
    case "le": {
      return comparison <= 0;
    }
    case "=":
    case "eq": {
      return comparison === 0;
    }
    case ">":
    case "gt": {
      return comparison > 0;
    }
    case ">=":
    case "ge": {
      return comparison >= 0;
    }
    default: {
      return false;
    }
  }
}

export function isAffected(
  version: string,
  operator: VulnerabilityOperator,
): boolean {
  if (
    operator.min_version &&
    operator.min_operator &&
    !isSatisfied(version, operator.min_operator, operator.min_version)
  )
    return false;
  if (
    operator.max_version &&
    operator.max_operator &&
    !isSatisfied(version, operator.max_operator, operator.max_version)
  )
    return false;
  return (
    Boolean(operator.min_version || operator.max_version) ||
    operator.unfixed === "1"
  );
}

// Core advisories write ranges as "A - B", ">= A <B", a bare version, or a comma list; `null` means unparseable
export function inAdvisoryRange(
  version: string,
  range: string,
): boolean | null {
  const trimmed = range.trim();
  const between = /^(\d[\d.]*)\s+-\s+(\d[\d.]*)$/.exec(trimmed);
  if (between?.[1] && between[2])
    return (
      compareVersions(version, between[1]) >= 0 &&
      compareVersions(version, between[2]) <= 0
    );

  const comparators = trimmed.matchAll(/(>=|<=|>|<|=)\s*(\d[\d.]*)/g).toArray();
  if (
    comparators.length > 0 &&
    trimmed
      .replaceAll(/(>=|<=|>|<|=)\s*\d[\d.]*/g, "")
      .replaceAll(/[\s,]/g, "") === ""
  ) {
    return comparators.every(
      ([, operator, bound]) =>
        operator !== undefined &&
        bound !== undefined &&
        isSatisfied(version, operator, bound),
    );
  }

  const listed = trimmed.split(/\s*,\s*(?:and\s+)?|\s+and\s+/);
  if (listed.every((entry) => /^\d[\d.]*$/.test(entry)))
    return listed.some((entry) => compareVersions(version, entry) === 0);
  return null;
}

export function lookupVulnerabilities(
  kind: "core" | ComponentKind,
  slug: string,
): Promise<Fetched<VulnerabilityRecord>> {
  return cached<VulnerabilityRecord>(
    `wpvulnerability:${kind}:${slug}`,
    async () => {
      const fetched = await requestJson(
        `https://www.wpvulnerability.net/${kind}/${encodeURIComponent(slug)}/`,
        {},
      );
      if (!fetched.isOk) return fetched;
      const body = fetched.value.body as {
        data?: null | { vulnerability?: null | Vulnerability[] };
      };
      if (!body.data)
        return { isOk: true, value: { isKnown: false, vulnerabilities: [] } };
      return {
        isOk: true,
        value: {
          isKnown: true,
          vulnerabilities: body.data.vulnerability ?? [],
        },
      };
    },
  );
}

function dateOnly(value: unknown): null | string {
  return typeof value === "string"
    ? (/^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null)
    : null;
}

function plainText(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll(/<[^>]*>/g, "").trim()
    : "";
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

// wordpress.org answers 404 both for a closed plugin (`error: "closed"`) and for one it never hosted
export function lookupDirectory(
  kind: ComponentKind,
  slug: string,
): Promise<Fetched<DirectoryRecord>> {
  return cached<DirectoryRecord>(`directory:${kind}:${slug}`, async () => {
    const endpoint =
      kind === "plugin"
        ? "plugins/info/1.2/?action=plugin_information"
        : "themes/info/1.2/?action=theme_information";
    const fields = [
      "sections",
      "versions",
      "reviews",
      "screenshots",
      "banners",
      "contributors",
      "ratings",
    ]
      .map((fieldName) => `&request[fields][${fieldName}]=0`)
      .join("");
    const fetched = await requestJson(
      `https://api.wordpress.org/${endpoint}&request[slug]=${encodeURIComponent(slug)}${fields}`,
      {},
    );
    if (!fetched.isOk) return fetched;
    const body = fetched.value.body as Record<string, unknown>;
    if (body["error"] === "closed") {
      return {
        isOk: true,
        value: {
          closedDate: dateOnly(body["closed_date"]),
          reason: plainText(body["reason_text"] ?? body["reason"]),
          state: "closed",
        },
      };
    }
    if (typeof body["error"] === "string" || fetched.value.status === 404)
      return { isOk: true, value: { state: "absent" } };
    if (fetched.value.status !== 200)
      return {
        error: `wordpress.org ${kind} ${slug}: HTTP ${fetched.value.status}`,
        isOk: false,
      };
    return {
      isOk: true,
      value: {
        headerAuthor:
          kind === "theme"
            ? plainText(field(body["author"], "author")) || null
            : null,
        lastUpdated: dateOnly(body["last_updated"]),
        owner:
          kind === "plugin"
            ? (/profiles\.wordpress\.org\/([^/"]+)/.exec(
                typeof body["author_profile"] === "string"
                  ? body["author_profile"]
                  : "",
              )?.[1] ?? plainText(body["author"]))
            : plainText(field(body["author"], "user_nicename")),
        requiresPhp:
          typeof body["requires_php"] === "string"
            ? body["requires_php"]
            : null,
        state: "listed",
        tested: typeof body["tested"] === "string" ? body["tested"] : null,
        version: typeof body["version"] === "string" ? body["version"] : "",
      },
    };
  });
}

export function lookupLatestCore(): Promise<Fetched<string>> {
  return cached<string>("core:latest", async () => {
    const fetched = await requestJson(
      "https://api.wordpress.org/core/version-check/1.7/",
      {},
    );
    if (!fetched.isOk) return fetched;
    const current = (fetched.value.body as { offers?: { current?: string }[] })
      .offers?.[0]?.current;
    return current
      ? { isOk: true, value: current }
      : { error: "core version-check: no current offer", isOk: false };
  });
}

interface GithubAdvisory {
  cve_id: null | string;
  ghsa_id: string;
  severity: string;
  summary: string;
  vulnerabilities:
    | null
    | {
        patched_versions: null | string;
        vulnerable_version_range: null | string;
      }[];
}

// Records each unparseable range it passes on the way to the first match
function firstAffectedRange(
  advisory: GithubAdvisory,
  version: string,
  unparsed: string[],
) {
  const ranges = advisory.vulnerabilities ?? [];
  for (const range of ranges) {
    const isIn = inAdvisoryRange(version, range.vulnerable_version_range ?? "");
    if (isIn === null)
      unparsed.push(
        `${advisory.ghsa_id}: ${range.vulnerable_version_range ?? "(none)"}`,
      );
    if (isIn) return range;
  }
  return;
}

// WPVulnerability misses some core advisories, so core is checked against the project's own
export function lookupCoreAdvisories(
  version: string,
): Promise<Fetched<{ matched: CoreAdvisory[]; unparsed: string[] }>> {
  return cached<{ matched: CoreAdvisory[]; unparsed: string[] }>(
    `core-advisories:${version}`,
    async () => {
      const advisories: GithubAdvisory[] = [];
      for (let page = 1; page <= 10; page++) {
        const url = `https://api.github.com/repos/WordPress/wordpress-develop/security-advisories?state=published&per_page=100&page=${page}`;
        const fetched = await requestJson(url, {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        });
        if (!fetched.isOk) return fetched;
        if (!Array.isArray(fetched.value.body))
          return {
            error: `GitHub advisories: HTTP ${fetched.value.status}`,
            isOk: false,
          };
        advisories.push(...(fetched.value.body as GithubAdvisory[]));
        if (fetched.value.body.length < 100) break;
      }

      const matched: CoreAdvisory[] = [];
      const unparsed: string[] = [];
      for (const advisory of advisories) {
        const range = firstAffectedRange(advisory, version, unparsed);
        if (!range) continue;
        matched.push({
          cve: advisory.cve_id,
          ghsa: advisory.ghsa_id,
          patched: range.patched_versions ?? "",
          severity: advisory.severity,
          summary: advisory.summary,
        });
      }
      return { isOk: true, value: { matched, unparsed } };
    },
  );
}

export function lookupKnownExploited(): Promise<Fetched<Set<string>>> {
  return cached<Set<string>>("kev", async () => {
    const fetched = await requestJson(
      "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
      {},
    );
    if (!fetched.isOk) return fetched;
    const entries = (
      fetched.value.body as { vulnerabilities?: { cveID: string }[] }
    ).vulnerabilities;
    if (!entries)
      return { error: "CISA KEV: no vulnerabilities list", isOk: false };
    return { isOk: true, value: new Set(entries.map((entry) => entry.cveID)) };
  });
}
