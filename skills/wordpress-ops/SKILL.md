---
name: wordpress-ops
description: "Working on a live WordPress install: checking how it behaves or whether it's compromised, reading its server logs, upgrading or modernizing PHP, core, themes and plugins, hardening it, and taking over abandoned code. Use whenever a task touches a running WordPress site rather than building a new theme or plugin."
---

# WordPress ops

A toolkit for working on live WordPress sites, often inherited, neglected or quietly compromised: principles to hold, the traps an agent can't see coming, and scripts for the mechanics that are hard to get right by hand. Size the work to the job; the files are reference, not a procedure.

## Principles

1. **As found.** Snapshot before the first write, and before the first wp-admin visit: opening the Plugins screen drops headerless `active_plugins` entries, which erases evidence. On a suspected compromise, pull every retained log the same day and keep that first copy read-only; build from copies, never from evidence.
2. **Quarantine.** On a server, move things aside with a manifest line instead of deleting them; the operator or the owner deletes.
3. **Rehearse** what can break the site: a theme switch, a PHP change, a plugin major, a migrator. Run it on a copy, write the runbook with each step's rollback beside it, replay live from a fresh snapshot. A routine update with a tested rollback needs a snapshot and a check from the web, not a rehearsal stack.
4. **Verify from the web.** WP-CLI, the CLI's PHP and a cache-busted request each misreport what visitors get. Confirm through served pages, Site Health and response headers, with requests both cache-busted and plain. A fix nobody saw working from the web is a hypothesis.
5. **Tools decide.** Checksums, scanners, diffs and counts give the verdicts; you orchestrate and report. A check shows only what it covers: say what it didn't look at.
6. **The owner's site.** Know who holds each account and who approves each write before writing anything ([engagement.md](engagement.md)). The operator approves server writes; panel actions and the owner's accounts stay theirs.
7. **No sign of misuse.** Absence of evidence is worded as absence of evidence, with the sources and counts behind it.

## Jobs

| Job | Files |
| --- | --- |
| Look a site over: how it behaves, whether it's compromised | [evidence.md](evidence.md) to snapshot, then [incident-response.md](incident-response.md) (indicator classes, database battery), [log-analysis.md](log-analysis.md), [tools.md](tools.md) |
| Contain and clean a compromise | [incident-response.md](incident-response.md), then [owner-handoff.md](owner-handoff.md) |
| Upgrade PHP, core or plugins | [upgrades.md](upgrades.md), with [local-stack.md](local-stack.md) for the rehearsal copy |
| Upgrade, switch or repair a theme | [theme-upgrades.md](theme-upgrades.md) |
| Take over an abandoned plugin or theme | [claiming-code.md](claiming-code.md) |
| Harden an inherited install | [hardening.md](hardening.md) |
| Start an engagement: access, authority, secrets | [engagement.md](engagement.md) |
| Tell the owner what's theirs to do | [owner-handoff.md](owner-handoff.md) |

## Tells

A white screen, a fatal only in wp-admin, stale pages, an alarming log line: snapshot first (**as found**), then find the tell. Each file keeps its traps as tables, and `grep -rn '<error text>' <skill>` finds most.

| Tells about | File |
| --- | --- |
| implants, hidden plugins or users, keys that come back, owner lockouts | [incident-response.md](incident-response.md) |
| log lines, reply sizes, an alarming claim from a reviewing agent | [log-analysis.md](log-analysis.md) |
| dumps, snapshots, copies, case collisions, hard links | [evidence.md](evidence.md) |
| the local copy misbehaving | [local-stack.md](local-stack.md) |
| fatals after a PHP, core or plugin change, the first admin load, empty sitemaps, caches and stale pages, the database server | [upgrades.md](upgrades.md) |
| layout or styling changed after a theme update, a migrator | [theme-upgrades.md](theme-upgrades.md) |
| checksums, scanners and feeds that pass or fail oddly | [tools.md](tools.md) |
| forks offered updates, data a save corrupts, a removal's leftovers | [claiming-code.md](claiming-code.md) |
| uploads rules, salts, 2FA, `DISALLOW_FILE_MODS`, files still served after deletion | [hardening.md](hardening.md) |
| shell traps, secrets | [engagement.md](engagement.md) |
| the host's paths, logs, permissions and purges | the host runbook |

## Host runbooks

Generic files say "managed host", "the panel" and "the CLI's PHP"; the concrete paths live in one runbook per host, loaded only when the site is there:

- [host-cloudways.md](host-cloudways.md): Cloudways.
- Self-managed servers: the server itself (firewall, SSH, TLS, off-server backups, deploys) is `vps-devops`'s; call the Skill tool with "vps-devops". The WordPress-level server rules stay in [hardening.md](hardening.md).

## Scripts

Zero-dependency TypeScript on Node 24, read-only or dry-run unless passed `--apply`. They fit one setup: SSH with bash, WP-CLI and rsync on the server, and Docker for the local copy. On a host they don't fit, run the same checks by hand from the branch file that describes them, or adapt the script; that file is the authority, and a script's clean result covers only its own checks.

| Script | Does |
| --- | --- |
| `scripts/snapshot.ts` | verified dump first, then logs and the docroot, resumable and deduplicated, with a manifest; `--all-logs` pulls every retained log read-only |
| `scripts/scan.ts` | integrity, vulnerability and code-triage scan with a headline; its indicators are the campaign packs in `scripts/ioc/`, so a pack-clean result says nothing about other campaigns |
| `scripts/smoke.ts` | marker-checked requests, wp-admin and an `admin-ajax.php` POST included, against the local copy or live (cache-busted and plain); on live, admin targets need a login the job already has, or are skipped |
| `scripts/live-check.ts` | for a live site where the job has no wp-admin login: a temporary administrator with minted cookies (no login, so no alert email), the deep smoke, the served PHP from Site Health, then full cleanup. Reach for it only when needed, with the operator's approval for that site |
| `templates/local-stack/rebuild.ts` | builds the rehearsal copy from a snapshot ([local-stack.md](local-stack.md)) |

Run each one in `scripts/` as `node <skill>/scripts/<script>.ts <site>` from anywhere in a workspace (`<skill>` is this skill's folder; `--help` prints the flags); `rebuild.ts` runs from the stack folder instead ([local-stack.md](local-stack.md)). They find `wordpress-ops.config.ts` by walking up from the working directory (start from `scripts/wordpress-ops.config.example.ts`), `<site>` is a key of its `sites`, and they write under `sites/<site>/`: `snapshots/<UTC stamp>/`, `reports/<kind>-<stamp>.md`, and the stack in `local/`. `--all-logs` writes to `archive/logs-<stamp>/<site>/` at the workspace root.

Pins, install lines and traps for every external tool are in [tools.md](tools.md).
