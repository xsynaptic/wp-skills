# Engagement: access, scope, authority, secrets

The ground rules for working on a site someone else owns, and what a workspace records about it.

## Access and scope

- **SSH key:** one per engagement, without a passphrase, since the scripts run SSH in batch mode (`ssh-keygen -t ed25519 -N "" -C "<workspace>-temp-<date>" -f ~/.ssh/<host>-<workspace>`). The operator adds the `.pub` in the panel (the host runbook names the page) and reads back the address and user. It goes on the removal list ([owner-handoff.md](owner-handoff.md)) the day it is made.
- **Every app on the server is in scope until ruled out.** Reconcile the panel's app list with the apps root on disk. Forgotten apps (a staging copy, a site served only at the host's default hostname, one the owner believes deleted) run the same vulnerable plugins with nobody watching. An app the operator rules out is left entirely alone, reads included, and recorded with the reason.
- **Read what the server knows** (apps, `wp option get home`, `wp core version`, `php -v`); ask a person only what it can't tell you: who owns each site, what they suspect, what old files are for, what the work should reach.
- **Retiring an app:** archive it and prove the copy (per-file SHA-256 against the server; the dump restored with per-table counts matching, [evidence.md](evidence.md)) before the operator deletes it in the panel.

## Authority

Before the first write, know for each account and action who holds it, who approves a write through it, and who performs it. The usual split when the operator helps with someone else's site:

| Who | Holds | Does |
| --- | --- | --- |
| Operator | the panel, SSH keys | approves server writes; performs panel actions |
| Owner | wp-admin, vendor accounts (backup storage, licences, CDN, DNS, mail) | updates, removals, 2FA, backup policy, password changes |
| Agent | nothing of its own | reads, rehearses, proposes, runs approved steps |

- A server write is proposed as one step: the exact command, what it changes, its rollback, why. A job the operator pre-approved, whose preflight passed, runs through without asking again.
- When a permission check refuses a server write or minting credentials, hand the operator the command to run as `! <command>`.
- A change that can't be undone in place (a bulk meta rewrite, a database-server upgrade) first names its rollback level (files only, or the exact snapshot stamp) and the evidence it is safe.
- Fixes to owned code (the theme, claimed plugins) land in the workspace source first and deploy from there; repairs to live data are the operator's call.
- Steps needing the owner's account are written as plain instructions the operator passes on; prefer a route through the panel or SSH where one exists, and a bulk route over leaving the owner hundreds of edits.
- A fix reported to the owner has been seen working on their side (their login, their screen).
- On a site with several stakeholders, no remote change happens until they approve; record the approval and its date.

Small managed servers are often already loaded. A bulk rsync, a dump, an uploads pass, a plugin batch, a scan and the host's own backup each count as heavy: one at a time per server, clear of the host's backup window.

## The workspace

Keep every site the operator looks after on one server, or one hosting account, in one workspace with one toolset: copies of the scripts drift, and a fix lands in one but not the other. Its `CLAUDE.md` records what a later session can't rediscover, with "unknown" and who can answer where a fact is missing:

- the authority split above, and how technical each owner is
- per server: host, OS, database version, size and load; the SSH user and key and whether it is temporary; docroot and log paths; the served PHP against the CLI's; where PHP errors land and what `error_reporting` hides; who runs updates and backups
- per app: id, domain, theme, notable plugins, caches and CDN, quirks, or "out of scope" and why
- code we deployed on the server, its source in the workspace, and whether it ever comes out
- where evidence lives (snapshots, archives, the as-found copy and what it still holds), each database's `DB_CHARSET` and anything that changes how it dumps
- each site's quarantine root and its `MANIFEST.txt`
- host traps that have bitten here, one line each
- **Decisions recorded as choices** ([owner-handoff.md](owner-handoff.md)), so no later session proposes them again

`.gitignore` keeps snapshots, dumps, archives, local stack data, vendor packages and every secret out of git. Anchor root patterns (`/archive/`, `sites/*/snapshots/`), since plugins ship folders with those names. Where agents never stage, move files with plain `mv` (`git mv` stages).

## Secrets

The work handles `wp-config.php` constants, salts, password hashes and the third-party tokens plugins store in options (backup storage, licence keys, API keys, webhook URLs, mail and CDN credentials). A value that prints is in the transcript for good, and regex masking leaks: JSON-escaped slashes, the escaped quotes of a serialized option and unquoted values slip past it. A search for secrets reports paths and counts (`grep -l`, `grep -c`), never the matching lines.

- **Config:** read names and lengths, never values: `wp config list --fields=name,type --format=csv`, and `wp config get DB_PASSWORD | tr -d '\n' | wc -c` for a length.
- **Structured values:** decode first, then print the shape with every string replaced by its length. Compare two values by a hash prefix (`| shasum -a 256 | cut -c1-12`).

  ```sh
  wp eval --skip-plugins --skip-themes '
    $value = json_decode(wp_json_encode(get_option("<option>")), true);
    if (is_array($value)) {
      array_walk_recursive($value, function (&$leaf) { if (is_string($leaf)) { $leaf = "len:" . strlen($leaf); } });
    } elseif (is_string($value)) {
      $value = "len:" . strlen($value);
    }
    echo wp_json_encode($value, JSON_PRETTY_PRINT), "\n";'
  ```

- **Passwords for a person:** write them to a file only that person reads (`umask 077`, a path under their home) and tell them the path.
- **Dumps** hold every hash and stored token: gitignored, out of synced folders, encrypted in any second copy. Delete scratch extracts and reports that picked up values.
- **A leak anyway** goes on the rotation list ([owner-handoff.md](owner-handoff.md)): what leaked, where it printed, who rotates it.

## Shell traps

| Trap | Tell | Fix |
| --- | --- | --- |
| the remote shell runs backticks in SQL passed to `ssh <host> 'wp db query "…"'` | a quoted identifier turns into a command error, or the query runs on the wrong text | send the SQL on stdin: `ssh <host> 'cd <docroot> && wp db query' < query.sql` |
| newer OpenSSH `scp` (SFTP mode) doesn't expand braces in remote paths | a multi-file `scp` or `rm` over `{a,b}` copies or deletes nothing, silently | spell every name out, or use rsync |
| curl globs `[]` and `{}` in URLs | wordpress.org API queries with `fields[…]` fail | `curl -g` |
| byte tools over dumps | `Illegal byte sequence`; `grep` prints `Binary file matches` | `LC_ALL=C` in front of grep, awk and cut, and `grep -a` |
