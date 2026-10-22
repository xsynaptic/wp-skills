# Upgrades: PHP, core, plugins, database server

Bringing a site to current PHP and core. **Rehearse** what can break it on a copy ([local-stack.md](local-stack.md)); a routine update with a tested rollback needs only a snapshot, the update and a check from the web. Theme upgrades and switches are [theme-upgrades.md](theme-upgrades.md); abandoned components get their disposition in [claiming-code.md](claiming-code.md).

## Order

- **Code first, PHP last.** Core, plugins and theme move while the current PHP still serves, so the PHP switch is a version change and nothing else. Where the PHP version is server-wide, every app on the server passes under the current version first, so a failure after the switch is attributable.
- **Old core under the old PHP.** Core too old for the target PHP (5.x can't run PHP 8) reaches current core on the current PHP first; until it does, testing on the target proves nothing.
- **Core gets its own step,** before the theme and plugins, so a break has one cause. On an old branch that can't leave its line yet, the branch's latest point release carries every backported security fix (every branch since 4.7 gets them).
- **A plugin's major on known core.** When a plugin's major and a core upgrade are both due, the plugin's major goes first on the current core, then core with that plugin's minor, so a plugin regression is never confused with a core one.
- **A site held back on purpose** (a downgrade plugin, a pinned core): date the hold from file mtimes clustered by minute (`TZ=UTC find wp-admin wp-includes -type f -exec stat -f '%Sm' -t '%F %H:%M' {} + | sort | uniq -c | sort -rn | head`, on a snapshot copy) and the holding plugin's options, then try to reproduce the old failure on a copy. Proceed when it doesn't reproduce; core's own step contains the risk.
- **One change at a time in rehearsal, batches live.**

## Auditing for a target PHP

What updates can't fix is what needs auditing: the theme and any parent, premium and off-repo plugins, closed plugins, mu-plugins and drop-ins.

- **Static scan** with PHPCompatibilityWP's alpha ([tools.md](tools.md#static-analysis); the stable 2.x line has almost no PHP 8 sniffs, so its clean result means nothing), with the range starting at the current PHP, since the code keeps running there until the switch:

  ```sh
  vendor/bin/phpcs -d memory_limit=1G --standard=PHPCompatibilityWP --runtime-set testVersion <current>-<target> \
    --extensions=php,inc --report=json -q local/site/wp-content/<component> > <component>.json
  docker run --rm -v "$PWD/local/site/wp-content:/code:ro" wordpress:php<target>-apache \
    sh -c 'find /code -name "*.php" -exec php -d error_reporting=-1 -d display_errors=stdout -d log_errors=0 -l {} \;' \
    | grep -v -e '^No syntax errors' -e '^$'
  ```

- **Lint for parse errors only.** PHP stops at a file's first parse error, so a log shows one per file and fixing it reveals the next: lint every file, never work from the log. The image's own ini leaves `E_DEPRECATED` out, and `xargs` stops at the first failing file, hence the flags and `-exec`. Lint never reports compile-time deprecations (implicitly nullable parameters, `${var}`) or run-time ones (null to `ltrim`); those come from phpcs and the runtime pass.
- **Third-party hooks.** Plugins drop deprecated hooks in minor releases, and a theme callback on a removed hook simply never fires: no error, just a missing `og:image`. List every plugin hook the theme and owned code register (`grep -rnE "add_(filter|action)\( *['\"]<plugin prefix>" <theme> <owned plugins>`), find each in the target release's source, and read the callback contract there. Move a missing one to a hook present in both releases, shipped before the upgrade; that plugin goes to manual updates ([hardening.md](hardening.md)).
- **Runtime pass:** a deep smoke on the target port, then that port's log through the noise floor, with `trace-errors.php` naming each warning's caller, plus the page-cache and WP-Cron paths if live runs them ([local-stack.md](local-stack.md#paths-the-smoke-doesnt-reach)). Static and runtime passes find different failures; neither alone is the audit.
- **Status from primary sources** (`scripts/scan.ts`, [tools.md](tools.md)): `requires_php` from the wordpress.org API, closure from the plugins API, each CVE's range against the installed version, core against GitHub's advisories. Secondary feeds have marked current plugins closed and unaffected versions vulnerable.

Every finding gets a class, and the audit report says what wasn't audited:

| Class | Tell | Example | Disposition |
| --- | --- | --- | --- |
| true fatal | removed function or syntax on a path that runs | `create_function` in a bundled options framework; `join($pieces, $glue)`; an instance method called statically, fatal only on the admin screen that calls it | vendor update, or a patch rehearsed like any change |
| never loaded | the file is never included on this site | parse errors in a bundled compiler the default setting never selects; a cache plugin's cloud SDK that loads only when that CDN is configured | non-blocking, with the include path traced |
| guarded false positive | behind `function_exists` or a `PHP_VERSION_ID` check | `mysql_errno()`, `get_magic_quotes_gpc()` in a security plugin | non-blocking |
| behaviour change | runs, but differently | `html_entity_decode()` without flags decodes single quotes from 8.1; a PHP 4 constructor never runs, so a shortcode it registered prints as raw `[tag]` text | note where it shows |
| deprecation or warning | logged, still works | implicitly nullable parameters (8.4), dynamic properties, null to `ltrim`, `${var}`; template globals old WordPress set (`$user_ID`, `$comment_author`, `$req`) undefined in an old `comments.php` | none before the next major PHP |

Reading closed and premium code for the audit often turns up worse than PHP 8 (an anonymous AJAX handler calling any function named in the request, an admin screen echoing `$_GET`): those go to [claiming-code.md](claiming-code.md). Before removing or replacing a component, count what live uses it for, so the replacement keeps it. Patching owned code: Rector with `withPhpVersion` pinned to the oldest PHP it still runs on and only the rules that fix the breakage ([tools.md](tools.md#static-analysis)).

## Rehearsing

- **Pin targets from the API's `requires_php`**, never from the server's WP-CLI, which checks against its own PHP and installs a release the served PHP can't run (`curl -sg 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=<slug>' | jq -r '.version, .requires_php'`). The newest release isn't always the pin: one added a warning on every archive and no security fix.
- **Assert the installed version before trusting a pass** (`wp plugin get <slug> --field=version`): an update loop whose pipeline broke updated nothing, and every smoke after it passed.
- **After each change:** one wp-admin load ([below](#the-first-admin-request)), the deep smoke on both ports, the logs through the noise floor, and the crawler diff where an SEO plugin changed.
- **Rollback is asymmetric.** Rehearse it, code first and the database last; a database restore is exact but drops what visitors wrote since the snapshot (comments, download counts, orders).
  - Core goes back in place when no upgrade routine between the two versions changes schema or data the old core reads (diff `wp-admin/includes/schema.php` and the `upgrade_<n>()` functions in `wp-admin/includes/upgrade.php` between the tarballs); otherwise its rollback is the snapshot.
  - A plugin downgrade can leave settings in their migrated form; diff its options against the before copy and say which differences only a restore removes.

### A runbook carries

For a change worth rehearsing, the runbook (`sites/<name>/update-runbook.md`) is what replays live:

- a version table: live, target, `requires_php`, and the reason for every pin and removal
- what the operator does in the panel first (limits with the measurement behind them, an on-demand backup for a step that can't be undone in place)
- staged packages outside the docroot, with SHA-256 checked
- per step: the exact commands, the expected output, the rollback beside it, the snapshot stamp it rolls back to
- the checks after each step: installed versions, a masked `wp-config.php` diff, a table-list diff, the live smoke, the host's PHP error log
- cache purges, outermost last, and the request that proves each took
- what is left for the owner, and a short rehearsal record (stamp, ports, what each step changed in the logs)

The masked config diff, and the saves a step restores from:

```sh
masked() { sed -E "s/(define\( *['\"][A-Z0-9_]+['\"] *, *).*/\1<value>/" "$1"; }
cp wp-config.php $S/wp-config.php.before   # holds the database password: delete after
diff <(masked $S/wp-config.php.before) <(masked wp-config.php)
wp db tables --all-tables-with-prefix > $S/tables.before
```

### The first admin request

Updated plugins finish upgrading on the first wp-admin request, not during `wp plugin update`. Follow each update with one admin load, and take the "after" snapshot and mirror after it.

| What happens | Seen with | Check | Handle |
| --- | --- | --- | --- |
| new modules switch on | Jetpack enables modules marked `Auto Activate: Yes` | `jetpack_active_modules` before and after | save the option, load wp-admin, write it back, confirm it holds after another admin load |
| `wp-config.php` rewritten | Really Simple Security adds session-cookie settings and an `RSSSL_KEY` define; W3 Total Cache rewrites its `WP_CACHE` line | the masked diff | a config diff in every step that updates a plugin |
| tables created or reshaped | Wordfence adds a passkeys table; frameworks add many | the table list before and after; row counts and content hashes of the plugin's own tables | prove the data survived |
| settings migrated or dropped | Really Simple Security 5 to 9 migrates its settings; Yoast rebuilds indexables; plugin majors delete their old options; W3 Total Cache 2.10 re-encrypts stored secrets on the next config save | the migrated option, the plugin's output on a page | rehearse from live's option values; save the old options (and `wp-content/w3tc-config/`) first; say what stops working |
| markup renamed | a rewrite renames its wrapper class, so the theme's CSS for it stops applying | grep served HTML for the old class | restyle against the new markup in the rehearsal |
| drop-in rewritten | a cache plugin regenerates `advanced-cache.php` with this host's paths | `head` of the drop-in; the mirror diff | snapshot and mirror only after the admin load |

### What crawlers get

An SEO plugin's major changes URLs and sitemaps without an error, and smoke markers can't see it. Capture the head lines of every smoke URL before the change, twice for the noise floor, then after:

```sh
seo_lines() { curl -s "$1" | grep -oiE '<(link rel="canonical"|meta (property|name)="(og|twitter|article|robots)[^"]*")[^>]*>' | sort; }
for url in <smoke URLs>; do seo_lines "$url" > "seo/<label>/$(printf %s "$url" | shasum | cut -c1-8)"; done
diff -r seo/before seo/after
curl -s "<sitemap URL>" | grep -c '<loc>'   # sum across child sitemaps; compare with: wp post list --post_status=publish --format=count
```

Expect cosmetic differences (entities printed as characters, seconds in times, void tags without ` />`) and list them as such.

### Rehearsal traps

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| Front end renders; wp-admin and every visitor AJAX feature (mega menu, live search, infinite load) fatal | an options framework bundled in the theme registers `create_function` on `init` for every `is_admin()` request, and `admin-ajax.php` counts | wp-admin targets and a POST of an unknown action to `admin-ajax.php`, which answers `400 0` only once WordPress boots cleanly | the vendor's update; patch each fatal in a throwaway copy to find the ones hidden behind it |
| The sitemap lists nothing (a 2-byte body, cached for months); the feed starts with blank lines; admin-ajax JSON breaks | bytes before `<?php` (or after a closing `?>`) in a theme or plugin file go out ahead of every response, and the SEO plugin refuses to build a sitemap once output has started | `curl -s "<url>/?cb=$RANDOM" \| head -c 40 \| od -c \| head -n 3` must start at `<`; per file, `head -c 5 <file> \| od -c` | delete the bytes, purge every cache, recount the sitemap's `<loc>` |
| Every page of one type 500s after a plugin major | the plugin now drives callbacks as generators (`valid()`, `next()`), and the theme's callback returns an array | status codes, then the log line | `yield` each item; roll the plugin back, fix on the old version, redo the step |
| Posts move to new URLs after an SEO plugin major; the old ones answer 200 with a canonical to the new | with no primary category set, the new major picks a different one of a post's categories | the canonical diff | set the primary-term meta on each moved post to the category that gives the old URL |
| The sitemap quietly lacks posts | the SEO plugin's sitemap query limit (2,000 by default in one) sits below the published count | `<loc>` count against the published count | raise the limit, and record it in the workspace `CLAUDE.md` |
| `wp core verify-checksums` reports missing files and stubs on every run | the install archive was truncated; minor updates ship only changed files, so the gaps never fill | stubs dated seconds before the first user was created rule out a failed update | `wp core download --force --skip-content --version=<installed>` and quarantine the stubs first, so later integrity checks mean something |
| `verify-checksums` prints `File should not exist` warnings, then `Success` | a downgrade left newer core files behind | match the warnings against the checksums of the versions in between | treat them as findings; the reinstall above removes them |
| `wp core update` on old core prints `Private methods cannot be final` and filesystem warnings | the old upgrader under a newer CLI PHP | the update completes and `wp core update-db` reports the new db version | harmless |

## Replaying live

- **A fresh snapshot** with nothing heavy running and the host's backup window clear; another right before the riskiest step when restoring the first would also undo work you mean to keep. The runbook names each stamp.
- **Batches:** pinned plugin updates run back to back with one check after the batch; when it fails, reinstall the batch's live versions (`wp plugin install <slug> --version=<live version> --force`) and redo them one at a time. Brief 500s while a batch replaces files are expected (a class missing mid-copy): judge the batch by the check after it.
- **The live smoke** after each step, cache-busted and plain (`scripts/smoke.ts <site> --deep`, admin targets through the login the job has). An empty error log is clean only once a count of past error lines shows the route works (the host runbook).
- **Live checks stay view-only,** since test actions write to production: a download test increments real counters, an admin save runs its sanitizer on live data, a test comment publishes where moderation is off, a probe POST to a payment callback writes rows. Exercise those on the copy and read the database on live.
- **Then** purge every cache layer and confirm each by headers, scan, snapshot and refresh the mirror; the mirror diff should show exactly the runbook's changes.
- **The PHP switch** comes last, once every app on the server has passed. It changes no files or rows, so switching back is its whole rollback; fix forward, and switch back only for a site that is down with no quick fix. Read each app's served version from Site Health afterwards.

### Cache layers

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| Visitors get years-old HTML pointing at old assets | a disk page cache served by `.htaccess` rewrites without PHP, never purged | a request with no query string: the cache plugin's footer comment (`Served from … @ <date>`) and `last-modified` | remove the cache path (next row), then purge the reverse proxy |
| A cache plugin is inactive, yet its caches run on every request | `WP_CACHE` and its `advanced-cache.php`, `db.php` and `object-cache.php` drop-ins stayed; they load regardless and are invisible in wp-admin, and deleting the plugin later breaks wp-admin while `db.php` remains | `head -n 5 wp-content/{advanced-cache,db,object-cache}.php; grep -n WP_CACHE wp-config.php` | `wp cache flush` while the drop-in still loads, quarantine the drop-ins and the cache folder, `wp config delete WP_CACHE` |
| A drop-in sits in `wp-content/` and does nothing | `WP_CACHE` is undefined, so `advanced-cache.php` never loads | `grep -n WP_CACHE wp-config.php` | the owner's decision, not a fix |
| An option changed from WP-CLI stays stale on the site (minutes for options, days for transients) | W3 Total Cache's object cache keys include the request host, and WP-CLI has none, so CLI writes land in another namespace | `redis-cli --scan --pattern 'w3tc_*_<host>_*'` against `'w3tc_*__0_*'` | run database upgrades in web context (wp-admin's `upgrade.php`, or a cache-busted front-end request for a plugin that upgrades on `init`); `wp core update` already fires core's loopback to `upgrade.php` |
| After a theme switch nothing looks broken, then pages mix versions | the reverse proxy serves cached old pages whose stylesheet is cached too | `age`, `x-cache: HIT` and the theme stylesheet's `ver=` in served HTML | purge the plugin cache, then the proxy, straight after the switch |
| A CSS deploy is invisible | the stylesheet is linked with no version, and the CDN keeps it for weeks | `curl -sI <stylesheet URL>`: a CDN `HIT` with a large `age` | enqueue it with a version (`filemtime()` of the file) |
| Behind a CDN, a purge seems not to take | the CDN may not cache HTML (`cf-cache-status: DYNAMIC`) while the proxy behind it does (`x-cache: HIT`); or the plugin's purge never reaches the proxy (the host runbook) | the headers below after every purge; a purge's own `200` proves nothing | purge the layer that holds the page |
| Smoke passes while visitors get stale pages | a cache-busting query string skips every cache layer | at least one plain request per site | both kinds in every check after a change |

```sh
curl -sI "https://<domain>/" | grep -iE '^(age|x-cache|cf-cache-status|last-modified):'
curl -s "https://<domain>/" | grep -oE 'themes/<theme>/[^"]*ver=[^"&]+' | sort -u
```

### Live smoke artifacts

| Tell | Cause | Fix |
| --- | --- | --- |
| A feed or page target 301s before any change | a canonical redirect (`x-redirect-by: WordPress`): trailing-slash permalinks send `/feed/` to `/feed` | target the canonical path; take a live baseline before the first change so old quirks aren't blamed on it |
| The site editor answers 302 | it redirects on unknown query parameters | no cache-busting on admin targets |
| A plugin screen's marker holds on every local run and fails live | a plugin that verifies a key with its vendor renders a different screen offline than online | markup from the wrapper both states share ([local-stack.md](local-stack.md#smoke-targets)) |
| `TypeError: terminated` mid-run | the connection dropped after the page was served | the access log shows the 200 and no PHP error that second; rerun that site's check |
| Limits planned from the panel are wrong | the effective `memory_limit` and `max_execution_time` come from more than one file | read them from inside WordPress: Site Health, or a security plugin's diagnostics page |

## Database server upgrades

A database-server major upgrade is one-way: dumps from the new version restore only into it, and the host may not downgrade. It waits on compatibility evidence for every site on the server, and is shelved when nothing forces it and the current version's support runs for years. Rehearse each site on the target version with an override file beside the stack:

```yaml
services:
  db:
    image: mariadb:<target>
    environment:
      MARIADB_AUTO_UPGRADE: "1"
```

That upgrades the stack's own volume in place, the way a host does, so copy the volume first (`docker run --rm -v <project>_db-data:/from -v <project>_db-data-copy:/to mariadb:<live version> sh -c 'cp -a /from/. /to/'`).

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| A restore fails on the first line | 11.4 dumps open with `/*M!999999\- enable the sandbox mode */`, which clients before 10.11.8 reject | `gzip -dc db.sql.gz \| head -n 1` | restore with a client at 10.11.8 or later |
| `Illegal mix of collations` on joins after a restore into 11.4 | a database created on 11.4 defaults to `utf8mb4_uca1400_ai_ci`, so a plugin's bare `CREATE TABLE` gets it while older tables keep theirs | `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()` before any upgrade or restore (live defaults can be `latin1`) | create the restore target with the old default collation before importing |
| Clients refuse to connect | 11.x clients require TLS | `ERROR 2026` | the server's own client, or `--skip-ssl` where it is honoured |
| Some redirect sources or notes never match, holding `?` | `latin1` tables silently stored `?` for characters they can't hold | `SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema = DATABASE() AND table_collation LIKE 'latin1%'` | confirm every row is ASCII (`SELECT COUNT(*) FROM <table> WHERE HEX(<column>) REGEXP '^(..)*[89A-F]'` is 0), then `ALTER TABLE <table> CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`; the owner re-enters entries that already lost characters |

The live route for a one-way upgrade is the host's own: rehearse every site locally, then upgrade a clone of the server first where the host offers one.
