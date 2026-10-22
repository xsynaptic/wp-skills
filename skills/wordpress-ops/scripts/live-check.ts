import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SiteContext } from "./config.ts";
import type { Remote } from "./remote.ts";

import {
  hasFlag,
  loadWorkspace,
  positionalArguments,
  siteContext,
  siteDirectory,
} from "./config.ts";
import { connect } from "./remote.ts";
import { formatResult, loadTargets, runSmoke, summarize } from "./smoke.ts";

const usage = `usage: node live-check.ts <site> [--apply] [--cleanup]
For a live site where the job holds no wp-admin login of its own: creates a temporary administrator,
runs the deep smoke with minted cookies, reads the served PHP, then removes the user and its traces.
With a login of your own, run smoke.ts --deep with smokeLogin or SMOKE_COOKIE instead.`;
const login = "ops-live-check";

interface Inspection {
  locks: Record<string, string>;
  user_exists: boolean;
}

interface Removal extends Inspection {
  deleted_posts: number;
}

interface Pending {
  locks: Record<string, string>;
  login: string;
  started: string;
}

function formatLocks(locks: Record<string, string>): string {
  return (
    Object.entries(locks)
      .map(([postId, lock]) => `${postId} ${lock === "" ? "(none)" : lock}`)
      .join(", ") || "none"
  );
}

// The edit screens rewrite `_edit_lock` on the posts they open, so those locks are put back afterwards
async function editedPostIds(context: SiteContext): Promise<string[]> {
  const targets = await loadTargets(context);
  const ids: string[] = [];
  for (const target of [...targets.required, ...targets.deep]) {
    const url = new URL(target.path, "http://site.invalid");
    const postId = url.searchParams.get("post");
    const isEdit =
      url.pathname.endsWith("/post.php") &&
      url.searchParams.get("action") === "edit";
    if (isEdit && postId !== null && /^\d+$/.test(postId)) ids.push(postId);
  }
  return [...new Set(ids)];
}

async function servedPhp(base: string, cookie: string): Promise<null | string> {
  const response = await fetch(`${base}/wp-admin/site-health.php?tab=debug`, {
    headers: { cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  return /PHP version<\/th>\s*<td[^>]*>([^<]*)/.exec(body)?.[1] ?? null;
}

async function readPending(file: string): Promise<null | Pending> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Pending;
  } catch {
    return null;
  }
}

// eslint-disable-next-line unicorn/consistent-boolean-name -- An action that reports whether it succeeded, not a predicate
async function removeUser(
  remote: Remote,
  helper: string,
  locks: Record<string, string>,
  pendingFile: string,
): Promise<boolean> {
  const pairs = Object.entries(locks).map(
    ([postId, lock]) => `${postId}=${lock}`,
  );
  const after = await remote.php<Removal>(helper, ["remove", login, ...pairs]);
  console.log(
    `cleanup: ${after.deleted_posts} posts deleted, ${login} ${after.user_exists ? "STILL EXISTS" : "deleted"}`,
  );
  console.log(`edit locks after: ${formatLocks(after.locks)}`);
  const isRestored =
    !after.user_exists &&
    Object.entries(locks).every(
      ([postId, lock]) => after.locks[postId] === lock,
    );
  if (!isRestored) {
    console.log("cleanup incomplete");
    return false;
  }
  await rm(pendingFile, { force: true });
  return true;
}

// A run killed with SIGKILL leaves the user and its pending record; this finishes what its cleanup would have done
async function cleanupLeftover(
  context: SiteContext,
  remote: Remote,
  helper: string,
  pendingFile: string,
): Promise<number> {
  const pending = await readPending(pendingFile);
  const before = await remote.php<Inspection>(helper, [
    "inspect",
    login,
    ...Object.keys(pending?.locks ?? {}),
  ]);
  console.log(
    `${login} ${before.user_exists ? "exists" : "doesn't exist"} on ${context.name}; pending record ${pending ? `from ${pending.started}, locks ${formatLocks(pending.locks)}` : "absent, so edit locks can't be restored"}`,
  );
  if (!hasFlag("apply")) {
    console.log(
      `dry run: --cleanup --apply deletes every post ${login} authored and the user${pending ? ", and restores the recorded locks" : ""}`,
    );
    return 0;
  }
  return (await removeUser(remote, helper, pending?.locks ?? {}, pendingFile))
    ? 0
    : 1;
}

async function liveCheck(
  context: SiteContext,
  remote: Remote,
  helper: string,
  pendingFile: string,
): Promise<number> {
  const base = context.site.url;
  const postIds = await editedPostIds(context);
  const before = await remote.php<Inspection>(helper, [
    "inspect",
    login,
    ...postIds,
  ]);
  if (before.user_exists) {
    throw new Error(
      `${login} already exists on ${context.name}, left by an interrupted run; inspect it, then run with --cleanup`,
    );
  }
  // Locks go back to the server as arguments, so anything but `time:user` stops the run before it writes
  const oddLocks = Object.entries(before.locks).filter(
    ([, lock]) => !/^(\d+:\d+)?$/.test(lock),
  );
  if (oddLocks.length > 0)
    throw new Error(
      `unexpected edit locks on ${context.name}: ${formatLocks(Object.fromEntries(oddLocks))}`,
    );
  console.log(`edit locks before: ${formatLocks(before.locks)}`);

  if (!hasFlag("apply")) {
    console.log(
      `dry run: --apply creates the administrator ${login} on ${base} via ${remote.label}, mints its cookies, runs the deep smoke, reads the served PHP from Site Health, then deletes every post it authored, the user, and restores the locks above`,
    );
    return 0;
  }

  const pending: Pending = {
    locks: before.locks,
    login,
    started: new Date().toISOString(),
  };
  await mkdir(path.dirname(pendingFile), { recursive: true });
  await writeFile(pendingFile, `${JSON.stringify(pending, null, "\t")}\n`);
  let cleanup: Promise<boolean> | undefined;
  // eslint-disable-next-line unicorn/consistent-boolean-name -- An action that reports whether it succeeded, not a predicate
  const cleanUp = () => {
    cleanup ??= removeUser(remote, helper, before.locks, pendingFile);
    return cleanup;
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      console.error(`\n${signal}: cleaning up before exit`);
      void cleanUp().finally(() => process.exit(130));
    });
  }

  let hasFailure = false;
  try {
    // Minted rather than logged in, since a password login fires security plugins' login alerts to the owner
    const scheme = new URL(base).protocol === "https:" ? "secure_auth" : "auth";
    const { cookie } = await remote.php<{ cookie: string }>(helper, [
      "create",
      login,
      scheme,
    ]);
    const results = await runSmoke({
      bases: [base],
      context,
      cookie,
      isDeep: true,
    });
    const failed = results.filter((result) => result.state !== "ok");
    console.log(`smoke: ${summarize(results)}`);
    for (const result of failed) console.log(formatResult(result));
    if (failed.length > 0) hasFailure = true;

    const version = await servedPhp(base, cookie);
    console.log(`served PHP (Site Health): ${version ?? "not found"}`);
    if (version === null) hasFailure = true;
  } finally {
    if (!(await cleanUp())) hasFailure = true;
  }
  return hasFailure ? 1 : 0;
}

// One site at a time by design: it creates an administrator on that site
const [name, ...extra] = positionalArguments();
if (!name || extra.length > 0 || hasFlag("help")) {
  console.error(usage);
  process.exit(2);
}
const context = siteContext(await loadWorkspace(), name);
const remote = connect(context);
const helper = await readFile(
  new URL("php/live-admin.php", import.meta.url),
  "utf8",
);
const pendingFile = path.join(
  siteDirectory(context),
  "live-check-pending.json",
);
console.log(`=== ${context.name} (${context.site.url})`);
try {
  process.exitCode = hasFlag("cleanup")
    ? await cleanupLeftover(context, remote, helper, pendingFile)
    : await liveCheck(context, remote, helper, pendingFile);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
