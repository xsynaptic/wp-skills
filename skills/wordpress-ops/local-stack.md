# Local stack: the rehearsal copy

A copy of one site, built from a verified snapshot, serving the site's current PHP and the target PHP side by side against one database. What a rehearsal needs is that shape, whatever builds it: outbound HTTP and mail cut off, a debug log per PHP version, a database you can checkpoint, and a way to serve a frozen before copy beside it. [templates/local-stack/](templates/local-stack/) is one build (Docker, the official WordPress Apache images, `rebuild.ts` taming the plugins marked below); another local tool works where it gives the same, and a host's staging copy rehearses with live's own PHP and caches but usually one PHP version at a time. The catalogue, smoke targets and noise floor apply to any of them.

## Building it from the template

1. **Fill the template.** Copy it to `sites/<name>/local/` and replace every `<placeholder>` in `compose.yaml`: a project name and three ports no other stack in the workspace uses, the served PHP as `current` (read from the web side, never the CLI), the target PHP, MariaDB at live's version. Uploads come from the snapshot (`--uploads`); only for a snapshot without them, uncomment the uploads-fallback mounts, which fetch missing files from the production origin (and so let a target pass on live's file). Put the host runbook's licence markers in `apache/host.conf` when it names any, and live's effective `memory_limit` and `max_execution_time` in `php/local.ini`.
2. **Rebuild** from a snapshot stamp (never `latest`, never an archive): `node rebuild.ts --snapshot ../snapshots/<stamp>` checks the dump and prints the plan; `--apply` builds. Add `--uploads ../snapshots/<stamp>/site/wp-content/uploads` to copy uploads from the snapshot that holds them (one whose `manifest.json` doesn't list `/wp-content/uploads/` under `excluded`), and `--repair-core` when the checksums it reports show missing, truncated or leftover core files. It ends `rebuild complete` once the import matched the dump's table count, every form of the site URL was replaced, and a notice planted on each port reached that port's `debug.log`.
3. **Make it serve.** Work through the catalogue below for whatever the rebuild didn't tame, and record each site-specific workaround with its reason in `local/README.md`, beside the stack's state (snapshot stamp, step reached). Log in as `localadmin` (password the same).
4. **Smoke targets** go in `local/smoke-targets.ts` ([below](#smoke-targets)); add the copy to `wordpress-ops.config.ts` as a site on a `docker` server (as `example-local` in `scripts/wordpress-ops.config.example.ts`), its `url` on the `current` port and `smokeLogin` set to `localadmin`.
5. **The noise floor** ([below](#noise-floor)), before the first change.

## Workaround catalogue

`rebuild.ts` and the template handle the rows marked so; the rest are by hand, in the copy's database or files only.

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| Every request redirects to `https://` | Really Simple Security's redirect and SSL flag (`rsssl_options` in 9.x, `rlrsssl_options` in 5.x) | `curl -sI http://localhost:<port>/ \| grep -i x-redirect-by` names the plugin | rebuild.ts. Rehearsing a 5.x to 9.x upgrade: set `rlrsssl_options` back to live's values first, since 9.x migrates from it on the first admin request |
| Login asks for an emailed code, or a captcha after the first attempt | Jetpack's Account Protection and Brute Force Protection (`protect`) can't reach their API | the login page; `wp option get jetpack_active_modules` | rebuild.ts drops both modules |
| Login blocked by reCAPTCHA, or 2FA demanded for administrators | Wordfence login security, which can't reach Google from here | the login page | rebuild.ts clears both settings and gives `localadmin` a grace period, since clearing the role setting alone didn't lift the 2FA block |
| `/author/<name>/` redirects to the home page | a security plugin's user-enumeration hardening, the same on live | `x-redirect-by` | drop author targets, or keep them only where live serves them |
| A page rendered under the old theme keeps being served after a switch | W3 Total Cache writes static pages to `wp-content/cache/page_enhanced/<host:port>/` even without its drop-in, and its `.htaccess` rules serve them without PHP | `ls wp-content/cache/page_enhanced/` | rebuild.ts turns its page cache off and empties `wp-content/cache`. Its first wp-admin load, update or not, rewrites `advanced-cache.php` and puts `define('WP_CACHE', true)` back at the top of `wp-config.php`, ahead of the local include, so `WP_CACHE` is true again (`Constant WP_CACHE already defined` in `docker compose logs`); with the page cache off the drop-in serves nothing, and a restored `db.php` loads either way |
| A plugin's folder and drop-in vanish after the first wp-admin request, and `active_plugins` drops it | a host-licensed build's kill switch, fired by a host check that fails off that host | grep the plugin for the host markers it reads | the markers in `apache/host.conf` before any admin request (the host runbook names them); rebuild if it already fired |
| Theme CSS or images come from production | a blanket uploads redirect also fetches files the copy writes itself (compiled LESS, new thumbnails) | list what the site writes under `uploads/` | the template's fallback, when mounted, serves local files first |
| wp-admin pages take many seconds each and a deep run takes many minutes; a tool timeout looks like a hang | outbound HTTP is blocked, so plugins wait on their calls | containers near 0% CPU while requests run | run deep smoke in the background and expect it |
| The copy would mail subscribers or call vendors with production credentials | the copied options hold live tokens | `wp option list --search='*token*' --fields=option_name` | the template blocks WordPress's HTTP API except wordpress.org, disables WP-Cron and drops `wp_mail()`; an SMTP plugin or a bundled HTTP client opens its own connection, so deactivate it in the copy |
| `wp db query` or `wp db export` fails: `ERROR 2026 (HY000): TLS/SSL error: SSL is required, but the server does not support it` | the WP-CLI image's newer MariaDB client demands TLS from a 10.11 server; `--skip-ssl` fixes `export` but not `query`, whose SQL-mode lookup ignores it | `docker compose run --rm cli wp db query 'SELECT 1'` | `docker compose exec db mariadb -uroot -pwordpress wordpress` for SQL, `mariadb-dump` in the same container for dumps, and a drop and recreate there instead of `wp db reset` |
| `wp` runs out of memory on a core download | the CLI image's default limit | the `Allowed memory size` message | `php/cli.ini` raises it |
| A plugin's cron callback errors once on the first cron run | catch-up: every overdue event ran at once | rerun the one event alone, on each PHP port | not a PHP finding; note it |
| A local download test counts on live, or audio 403s only on the copy | a fallback or proxy to production for media paths also catches the download routes, so live's handler serves them; signed file links bind the client address, and the container signs for its IPv4 while the browser reaches the file server over IPv6 | live's access log, or its download table, gains the row | exercise the local handler by its query-string route; check the same page on live before calling a 403 a regression |
| Plugins deactivated for parity are active again | a raw live dump reactivates them on every restore | `wp plugin list --status=active` after a restore | deactivate (never delete: some are no longer downloadable) after each restore, and say so in `local/README.md` |
| A render or log diff after copying a file in shows no change | OPcache keeps running the old script for `opcache.revalidate_freq` seconds | `docker compose exec current php -i \| grep revalidate_freq` | the template's `php/local.ini` sets 0 and is mounted as `zz-local.ini` so it loads after the image's file; on another stack wait out the delay or restart the service, and either way check that a diff holds the change you made before calling it identical |
| Links in content lead to the `current` port while browsing `target` | the database holds `current`'s URL; `WP_HOME` follows the request's host |  | for a byte-level diff, request `target` with `Host: localhost:<current port>` |

The `cli` service runs neither the current nor the target PHP, so a WP-CLI command that succeeds there says nothing about either port; old core printing deprecations under it is noise. The scripts' docker transport execs into it, so start it before pointing `scan.ts` or `snapshot.ts` at the copy: `docker compose --profile cli up --detach cli`.

## Smoke targets

The schema (required and deep targets, markers, admin flags; the base URL comes from the site's `url` in `wordpress-ops.config.ts` or a repeatable `--base=`) is `scripts/smoke-targets.example.ts`; the runner adds wp-admin and an `admin-ajax.php` POST on its own. Start from this list and cut what the site lacks:

| Target | Marker |
| --- | --- |
| home, a recent post, a page | `class="home `, `postid-<id>`, `page-id-<id>`; for a theme that prints a bare `<body>`, `id="post-<id>"` from the loop and the `<title>` text |
| one post from each era of the site (before and after each redesign or theme change) | `postid-<id>` |
| category, tag, author, date archive, search (`/?s=<word>`) | `category-<slug>`, `tag-<slug>`, `author`, `date`, `search-results` |
| 404 (status 404), feed, sitemap, REST root | `error404`, `<rss`, `<urlset` or `<sitemapindex`, `"namespaces"` |
| every visitor route the theme's scripts call (live search, infinite load, block paging), over `admin-ajax.php` or REST, with parameters read from each callback | a class only that route's HTML holds |
| wp-admin: posts and pages lists, a post and a page edit screen, new post, media, categories, customizer, widgets, menus, themes, plugins, users, profile, settings, Site Health, updates | `wp-list-table`, `post_ID`, `customize-controls`, `widgets-holder-wrap`, `your-profile`, `health-check` |
| the admin screen of every active plugin | a class or id only that screen renders: the slug alone sits in the admin menu on every page |
| a static file or old non-WordPress page the site still serves | its own `<title>` or a known `href`; for an image, its magic bytes (`JFIF`) |

- A marker is something only a fully rendered page of that kind contains: a body class or a container. Error strings make poor markers, since core's scripts contain softer error phrases.
- A plugin that verifies a key with its vendor renders a different settings screen on the copy, which can't reach the vendor, than on live, so a marker that held on every local run fails live (Akismet shows its start view offline and its configuration view live). Take markup from the wrapper both states share. Likewise a screen that changes with pending work: `upgrade-plugins-table` exists only while updates are pending, `class="core-updates"` always.
- After a theme change, re-derive the routes and markers from the new code: a theme that moved its visitor features from `admin-ajax.php` to REST leaves the old AJAX checks passing on `400 0` for an action that no longer exists, and a renamed content wrapper fails a post target on a page that renders fine. Markers that match both versions keep before and after comparable.
- Opening an edit screen rewrites that post's `_edit_lock` and `post-new.php` leaves an auto-draft: harmless here; on live, an admin smoke leaves the same, and `scripts/live-check.ts` cleans up after its own user.

## Noise floor

Each run starts from an empty log, so the lines of one run are that run's alone:

```sh
: > logs/current/debug.log   # then a deep smoke run on the current port
cp logs/current/debug.log baseline/current-1.log
: > logs/current/debug.log   # and a second run
cp logs/current/debug.log baseline/current-2.log
```

```sh
normalized() { sed -E 's/^\[[^]]*\] //; s/_[0-9a-f]{32}/_<cookiehash>/g' "$@" | sort -u; }
comm -3 <(normalized baseline/current-1.log) <(normalized baseline/current-2.log)   # noise: in one run only
comm -13 <(normalized baseline/current-*.log) <(normalized logs/current/debug.log)  # after a change: new lines
```

After each rehearsed change the second command, run against each port's log, is the finding list; a line it prints is explained before the next change. The second substitution masks `COOKIEHASH`, an MD5 of the site URL that differs per port (`WP_HOME` follows the request host), so `Undefined array key "wp-postpass_<hash>"` reads as the same line on both.

The copy runs with `WP_DEBUG` on, so its log holds notices, deprecations and `_deprecated_function()` calls. Live, with `WP_DEBUG` off, logs none of them: WordPress then sets `error_reporting` to errors and warnings, and the host may cut more (the host runbook). So:

- Compare live's log after a change against the copy's warnings and errors only.
- Deprecations are evidence from the copy alone: fixing one changes nothing in live's log, and one live never shows is still real.

## Paths the smoke doesn't reach

The template turns off the page cache and WP-Cron, so code that only runs inside them never runs on either port. When live runs them (a cache plugin's file in live's error log, `wp-cron.php` in its access log), exercise each from a checkpoint (below) and return to it after.

- **Page cache:** change `WP_CACHE` to true in `site/wp-config-local.php` only, restore the plugin's `advanced-cache.php` from the snapshot, then replay live's trigger (the referer in live's error line, such as a comment POST followed by the page with the cookie it set) on each port and read both logs. Revert, and empty `wp-content/cache`.
- **WP-Cron:** make every event due, then request `wp-cron.php` on one port, read its log, restore the checkpoint, and repeat on the other port. The CLI's PHP only moves data here:

  ```sh
  docker compose run --rm -T cli wp eval --skip-plugins --skip-themes '
    $due = array();
    foreach ( _get_cron_array() as $time => $hooks ) { $due[ $time - 30 * DAY_IN_SECONDS ] = $hooks; }
    _set_cron_array( $due );'
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:<port>/wp-cron.php"
  ```

  Core's own events run too: its auto-updater reaches wordpress.org, which the template allows, and `wp_delete_temp_updater_backups` deletes `wp-content/upgrade-temp-backup/`. Diff `site/` against the snapshot afterwards, and restore code from the clone taken at the checkpoint.

Each path live runs gets a log read on both ports, and the copy goes back to its checkpoint after.

## Attributing a warning

A warning raised inside core (`Array to string conversion` in `wp-includes/formatting.php`) names core's file, not the code that passed the bad value. Copy [templates/local-stack/trace-errors.php](templates/local-stack/trace-errors.php) into `site/wp-content/mu-plugins/`, reproduce the request, and read the `TRACE [<plugin or theme file:line>]` line beside each message; extend the probe in place when the frame isn't enough (to print which customizer control it was, say), then delete it. A warning that turns out to be vendor code is recorded as a known vendor warning, with the frame, rather than patched.

## Checkpoints and the before copy

Save the database at each rehearsal point the runbook may need to return to (as rebuilt, before a risky step, the final state), named for the point:

```sh
docker compose exec -T db mariadb-dump -uroot -pwordpress --single-transaction --default-character-set=utf8mb4 wordpress | gzip -c > db/local-<label>.sql.gz
gzip -dc db/local-<label>.sql.gz | docker compose exec -T db mariadb -uroot -pwordpress wordpress   # back to that point
```

Code goes back with an APFS clone taken at the same point (`cp -cR site site-<label>`), under a label not used yet: `cp -cR` into an existing folder nests the copy inside it. Before a theme or design change, freeze the copy and serve it beside the stack on the `before` port, so renders and computed styles can be compared side by side. The freeze refuses to run over an earlier one, which may still be the comparison in use:

```sh
if [ -e site-before ]; then
  echo 'site-before exists: compare against it, or retire it first (rm -rf site-before, then DROP DATABASE wordpress_before)' >&2
else
  cp -cR site site-before
  docker compose exec -T db mariadb-dump -uroot -pwordpress --single-transaction --default-character-set=utf8mb4 wordpress | gzip -c > db/local-before.sql.gz
  docker compose exec -T db mariadb -uroot -pwordpress -e "CREATE DATABASE IF NOT EXISTS wordpress_before; GRANT ALL ON wordpress_before.* TO 'wordpress'@'%';"
  gzip -dc db/local-before.sql.gz | docker compose exec -T db mariadb -uroot -pwordpress wordpress_before
fi
docker compose --profile before up --detach --wait before
docker compose run --rm -T -e LOCAL_DB_NAME=wordpress_before cli wp option get <option> --format=json --skip-plugins --skip-themes   # read the before copy
```

To compare two snapshots once a change already ran live, copy the template into a scratch folder with its own project name and ports and rebuild it from the earlier stamp.
