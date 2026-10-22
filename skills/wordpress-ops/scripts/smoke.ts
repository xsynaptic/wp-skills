import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SiteContext, SmokeTarget, SmokeTargets } from "./config.ts";

import {
  flagValues,
  hasFlag,
  loadWorkspace,
  positionalArguments,
  siteContext,
} from "./config.ts";

const usage = "usage: node smoke.ts <site> [--deep] [--base=<url>...]";

// Core's own JS strings contain softer phrases, so match only what a PHP fatal or WordPress's fatal handler prints
const failureMarkers = [
  "There has been a critical error",
  "Fatal error</b>",
  "PHP Fatal error",
];

const wordpressTargets: SmokeTarget[] = [
  {
    isAdmin: true,
    label: "wp-admin",
    marker: "wp-admin-bar",
    path: "/wp-admin/",
  },
  // An unknown action answers 400 with body "0" once init has run cleanly
  {
    body: { action: "wordpress-ops-smoke" },
    isExact: true,
    label: "admin-ajax",
    marker: "0",
    method: "POST",
    path: "/wp-admin/admin-ajax.php",
    status: 400,
  },
];

export interface SmokeResult {
  base: string;
  label: string;
  note: string;
  state: "failed" | "ok" | "skipped";
  status: number;
}

interface SmokeOptions {
  bases: string[];
  context: SiteContext;
  // An administrator session; without one the runner logs in with `smokeLogin`
  cookie?: string;
  isDeep: boolean;
  onResult?: (result: SmokeResult) => void;
}

export async function loadTargets(context: SiteContext): Promise<SmokeTargets> {
  if (!context.site.smokeTargets)
    throw new Error(`site ${context.name} has no smokeTargets in the config`);
  const file = path.resolve(context.workspace.root, context.site.smokeTargets);
  const imported = (await import(pathToFileURL(file).href)) as {
    default?: SmokeTargets;
  };
  if (!imported.default) throw new Error(`${file} has no default export`);
  return imported.default;
}

async function logIn(base: string, context: SiteContext): Promise<string> {
  const login = context.site.smokeLogin;
  if (!login)
    throw new Error(
      `admin targets on ${context.name} need smokeLogin in the config, or an administrator cookie in SMOKE_COOKIE`,
    );
  const testCookie = "wordpress_test_cookie=WP%20Cookie%20check";
  const response = await fetch(`${base}/wp-login.php`, {
    body: new URLSearchParams({
      log: login.user,
      pwd: login.password,
      redirect_to: `${base}/wp-admin/`,
      testcookie: "1",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: testCookie,
    },
    method: "POST",
    redirect: "manual",
  });
  await response.body?.cancel();
  const cookies = response.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0] ?? "");
  if (cookies.every((cookie) => !cookie.startsWith("wordpress_logged_in_")))
    throw new Error(
      `login as ${login.user} at ${base} failed (HTTP ${response.status})`,
    );
  return [testCookie, ...cookies].join("; ");
}

async function check(
  base: string,
  target: SmokeTarget,
  cookie: string,
  query: string,
): Promise<SmokeResult> {
  const url = query
    ? `${base}${target.path}${target.path.includes("?") ? "&" : "?"}${query}`
    : base + target.path;
  const response = await fetch(url, {
    headers: { cookie: target.isAdmin ? cookie : "" },
    method: target.method ?? "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
    ...(target.body && { body: new URLSearchParams(target.body) }),
  });
  const body = await response.text();
  const result = { base, label: target.label, status: response.status };
  const failure = failureMarkers.find((text) => body.includes(text));
  if (failure) return { ...result, note: failure, state: "failed" };
  if (response.status !== (target.status ?? 200))
    return {
      ...result,
      note:
        response.headers.get("location") ??
        body.slice(0, 120).replaceAll("\n", " "),
      state: "failed",
    };
  // A marker is required on every target, so an endpoint that vanished can't pass on a bare sentinel answer
  const hasMarker = target.isExact
    ? body.trim() === target.marker
    : body.includes(target.marker);
  if (!hasMarker)
    return {
      ...result,
      note: `missing ${target.isExact ? "exact body " : ""}${JSON.stringify(target.marker)} (${body.length}B)`,
      state: "failed",
    };
  return { ...result, note: `${body.length}B`, state: "ok" };
}

// A live site with neither session nor login runs its public targets only
async function adminCookie(
  base: string,
  context: SiteContext,
  cookie: string | undefined,
): Promise<string | undefined> {
  if (cookie) return cookie;
  if (context.server.transport === "ssh" && !context.site.smokeLogin)
    return undefined;
  return logIn(base, context);
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult[]> {
  const { context } = options;
  const targets = await loadTargets(context);
  const selected = [
    ...targets.required,
    ...wordpressTargets,
    ...(options.isDeep ? targets.deep : []),
  ];
  // Live sites sit behind page caches: cache-busted requests see the change, plain ones see what visitors get
  const isLive = context.server.transport === "ssh";
  const cacheBust = `smoke=${Date.now()}`;
  const results: SmokeResult[] = [];

  for (const base of options.bases) {
    const requiresAdmin = selected.some((target) => target.isAdmin);
    const cookie = requiresAdmin
      ? await adminCookie(base, context, options.cookie)
      : "";
    for (const target of selected) {
      if (cookie === undefined && target.isAdmin) {
        const result: SmokeResult = {
          base,
          label: target.label,
          note: "no admin session (SMOKE_COOKIE or smokeLogin)",
          state: "skipped",
          status: 0,
        };
        results.push(result);
        options.onResult?.(result);
        continue;
      }
      // Admin pages are never cached, and the site editor redirects on an unknown query parameter
      const variants =
        isLive && !target.isAdmin
          ? [
              { query: cacheBust, suffix: "" },
              { query: "", suffix: " (plain)" },
            ]
          : [{ query: "", suffix: "" }];
      for (const variant of variants) {
        let outcome: SmokeResult;
        try {
          outcome = await check(base, target, cookie ?? "", variant.query);
        } catch (error) {
          outcome = {
            base,
            label: target.label,
            note: error instanceof Error ? error.message : String(error),
            state: "failed",
            status: 0,
          };
        }
        const result = {
          ...outcome,
          label: `${outcome.label}${variant.suffix}`,
        };
        results.push(result);
        options.onResult?.(result);
      }
    }
  }
  return results;
}

const stateLabels = { failed: "FAIL", ok: "ok  ", skipped: "skip" } as const;

export function formatResult(result: SmokeResult): string {
  return `${new URL(result.base).host} ${stateLabels[result.state]} ${result.label.padEnd(18)} ${result.status} ${result.note}`;
}

export function summarize(results: readonly SmokeResult[]): string {
  const count = (state: SmokeResult["state"]) =>
    results.filter((result) => result.state === state).length;
  const skipped = count("skipped");
  const summary = `${count("ok")} ok, ${count("failed")} failed`;
  if (skipped === 0) return summary;
  return `${summary}, ${skipped} admin targets skipped (no admin session)`;
}

if (import.meta.main) {
  const [name] = positionalArguments();
  if (!name || hasFlag("help")) {
    console.error(usage);
    process.exit(2);
  }
  const context = siteContext(await loadWorkspace(), name);
  const bases = flagValues("base");
  const cookie = process.env["SMOKE_COOKIE"];
  try {
    const results = await runSmoke({
      bases: bases.length > 0 ? bases : [context.site.url],
      context,
      isDeep: hasFlag("deep"),
      ...(cookie && { cookie }),
      onResult: (result) => {
        console.log(formatResult(result));
      },
    });
    console.log(summarize(results));
    process.exitCode = results.some((result) => result.state === "failed")
      ? 1
      : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
