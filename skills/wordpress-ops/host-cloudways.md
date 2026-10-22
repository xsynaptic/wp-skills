# Host runbook: Cloudways

The concrete paths and traps behind "managed host", "the panel" and "the CLI's PHP" in the other files, for a Cloudways server (Debian, nginx in front of Varnish and Apache, PHP-FPM, MariaDB). Facts dated 2026-10-21; the panel changes, so re-check a menu path before sending the operator to it.

## Layout

```
~/applications/<app>/public_html        docroot; wp-config.php requires wp-salt.php by relative path
~/applications/<app>/logs/               access, error and slow logs: about 30 days, plus stale old rotations
~/applications/<app>/conf/fpm-pool.conf  per-app PHP-FPM overrides, unreadable to the master user
/etc/php/<v>/fpm/php.ini                 server-wide PHP defaults
/etc/php/<v>/fpm/pool.d/<app>-<v>.conf   the pool's path names the served PHP version
/home/master/applications -> /home/<server id>.cloudwaysapps.com
```

- **Users:** SSH as the server's master user, whose home is `/home/master` even when it carries an old custom name without the `master_` prefix (the panel's Master Credentials page names it). Each app's PHP runs as that app's own user. A temporary SSH key goes in under Master Credentials, SSH Public Keys, and comes out when the work ends; the same page shows the server's public IP and the master username for the config.
- **WP-CLI** runs from the docroot (the relative `require` of `wp-salt.php` breaks anywhere else) with `--skip-plugins --skip-themes`; drop-ins in `wp-content/` still load.
- **Hostnames:** every app answers at a default `*.cloudwaysapps.com` hostname, which also names its log files (`backend_<type>-<server id>-<n>.cloudwaysapps.com.error.log`). An app reachable only there still belongs in the inventory. Hostnames no app claims land on one app acting as the catch-all, so scanner traffic for made-up subdomains (wildcard DNS) shows in that app's logs, not the target's.
- **Times:** server-side `find -printf` and the logs are UTC; so are the panel's backup times.
- **Served PHP:** sites send no `X-Powered-By`, so when `snapshot.ts` finds no cached Site Health value either, `ls /etc/php/*/fpm/pool.d/` names it (`<app>-82.conf` is 8.2).
- **The rest of the account** ([evidence.md](evidence.md#beyond-the-docroot)): `~/applications/<app>/` minus `public_html`, `logs` and `ssl` (it holds `conf/` and the panel's `local_backups/backup.tgz`, the docroot plus its own `.sql`), the home dotfiles, and `/etc/php`, `/etc/nginx`, `/etc/apache2`, `/etc/varnish` and `/etc/mysql`. Some server config is mode `0064` (owner can't read): its local copy then fails the as-found clone until `chmod u+r`.

## Panel-only actions

The operator performs these; write each as a step for them: PHP version (server-wide), PHP-FPM limits per app (Application Settings) and server defaults (Settings & Packages), Xdebug (the toggle takes effect only after its own Save Changes; confirm with the web-side probe in [hardening.md](hardening.md)), backups (schedule, retention, on-demand, restore), Reset Permission, MariaDB version, server size, SSH keys, adding or deleting an app. Varnish can also be purged over SSH (the trap below).

## Logs

| File | Records |
| --- | --- |
| `nginx-app.status.log` | requests nginx proxied on |
| `static_*.access.log` | requests nginx answered itself: static files, blocks, bot challenges |
| `backend_*.access.log` | requests that reached Apache, so WordPress |
| `php-app.access.log` | what PHP-FPM ran: the script, the request body size, `REQUEST_URI` as the last field |
| `backend_*.error.log` | PHP errors, as Apache `AH01071` lines through `proxy_fcgi` |
| nginx error log | refusals, and the only place the Host header appears |
| slow log | slow scripts and FPM pool changes |

- A `200` of 11.9 to 12.6 KB (or 0 bytes) that nginx answered alone, with `http_access_checker: splash` in the error log, is the bot-protection challenge, not site content; most scanner "200"s are this.
- Most direct requests for `.php` under `wp-content/` never reach PHP, but some do (`index.php` files, a plugin's own endpoint), and `%2e`-encoded paths have slipped past nginx's rules. What PHP actually ran comes from `php-app.access.log`.
- Some rotated files are unreadable to the master user (rsync exit 23); the panel's malware-scan history keeps about a month.

The PHP version is server-wide, so the switch comes last and covers every app on the server at once ([upgrades.md](upgrades.md#replaying-live)).

## Traps

Cache headers, used below: `curl -sI "https://<domain>/" | grep -iE '^(age|x-cache|cf-cache-status):'`.

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| WP-CLI succeeds; the site fatals, or `wp plugin update` installs a release the site can't run | the CLI's PHP (8.2, security support ends 2026-12-31) isn't the served PHP, and `wp plugin update` checks `Requires PHP` against the CLI | `php -v` over SSH against Site Health or the pool file's path | pin every update with `--version` from the API's `requires_php`; never `--all` |
| Empty error log after a change: clean, or misrouted? | FPM's own log is root-only; PHP messages reach `backend_*.error.log` as `AH01071`; FPM's `error_reporting` is `E_ALL & ~E_DEPRECATED` | `grep -c AH01071 ~/applications/<app>/logs/backend_*.error.log*` above zero proves the route works | read the backend error log; find deprecations on the rehearsal stack |
| `scp: dest open … No such file or directory` on a docroot path | `/home/master/applications` is a symlink the SFTP side doesn't resolve | `ls -ld /home/master/applications` | `rsync -e ssh`, or `ssh <host> 'cat > <file>' < <file>`, then `chmod 664` |
| A folder's `.htaccess` deny rule doesn't stop downloads | nginx serves static files without reading `.htaccess`, though some folders are blocked at nginx | HEAD the file, a nonexistent file in the same folder, and an ordinary theme file: the same 403 for the first two means a folder block | test each folder; quarantine exposed files either way |
| Asking for PHP limits that are already high | limits live in two places, and the per-app file is unreadable | `/etc/php/<v>/fpm/php.ini` for defaults; the effective value from inside WordPress (Site Health, or a security plugin's diagnostics page) | the panel paths in "Panel-only actions"; confirm the effective value after |
| Snapshots slow to a crawl, SSH drops, the disk fills | the panel's backup runs at a UTC time; the first one tars everything, uploads included; local backup copies stay on the server's disk | mtimes of the server's backup folders show the real schedule; `df -h` | start nothing heavy within an hour of the backup; retention and local copies are the owner's call; an on-demand panel backup is the rollback for a step that can't be undone in place |
| `Permission denied` moving or updating an app's files; rsync exits 23 on a deploy | the master user and the app user own different files; anything the master user moves in becomes master-owned, which WordPress then can't update, and rsync can't set times or modes on directories it doesn't own | `id; ls -ld <path>; test -w <path> && echo writable`, right before asking (ownership can change on its own) | quarantine logs "permission denied, left in place" and continues; deploys use `rsync -rcO --no-perms`; the operator runs Reset Permission after any step that moves folders in |
| An app's folder and `object-cache.php` vanish on a local copy | Object Cache Pro's Cloudways build has a kill switch: on `is_admin() && ! wp_doing_ajax()` off Cloudways it deletes its folder and drop-in and leaves `active_plugins`. Moving host does the same | `grep -rn 'function killSwitch' wp-content/plugins/*/src/Plugin/Licensing.php`; it detects the host by `.cloudwaysapps.com/` in `DOCUMENT_ROOT` or a `CW_ALLOWED_IP` server variable | `SetEnv CW_ALLOWED_IP 127.0.0.1` in the rehearsal stack's `apache/host.conf` before any admin request ([local-stack.md](local-stack.md)), and rebuild from the snapshot if it already fired |
| A MariaDB upgrade looks routine in the panel | it is one-way: support won't downgrade, and dumps from the new version restore only into it | the current version's support dates (10.11 LTS runs to February 2028) | rehearse every site on the server locally on the target version, then clone the server in the panel and upgrade the clone |
| A purge is still on the plan a day later | Varnish has been seen refreshing on its own within hours | the cache headers | check `age` before scheduling a purge; drop moot ones |
| Varnish still serves the old page after a plugin purge | W3 Total Cache's `varnish.servers` set to the site's public hostname goes out through the CDN, so neither `wp w3-total-cache flush all` nor a per-post purge reaches Varnish; a `BAN` answers 200 and clears nothing. Breeze's Purge All does purge Varnish ("Varnish Cache has been purged") | the cache headers after every purge: `x-cache: MISS` and `age: 0` | from the server, `curl -X PURGE -H "Host: <domain>" -H "X-Purge-Method: regex" "http://127.0.0.1:8080/.*"` for everything, or `curl -X PURGE -H "Host: <domain>" "http://127.0.0.1:8080/<path>"` for one URL (through port 80, a path nginx denies answers 403 before Varnish sees it); the owner points `varnish.servers` at `127.0.0.1:8080` |
| A removed plugin's PHP endpoint answers 403, not 404 | origin nginx on some servers refuses every `.php` path under `/wp-content/`, existing or not, by a rule absent from the readable config | `/wp-content/<random>.php` gets the same 403 | 403 is the end state; purge Varnish so its cached copy goes too |
| Every `wp` command fatals | the master user's `~/.wp-cli/packages` autoloads a host package whose files are missing | `wp --info` fails naming `.wp-cli/packages` | prefix `WP_CLI_PACKAGES_DIR=/nonexistent-wp-cli-packages` (the server's `wpCliPrefix` in `wordpress-ops.config.ts`) |
| Long SSH jobs exit 255 partway | the server is overloaded, worst near the backup window | the exit code | `-o ServerAliveInterval=30` keepalives, multiplexing, one app per call, retry |
| `logs/` holds dozens of rotations back to years ago | access-log rotations from years ago are stale leftovers beside about a month of current ones; nginx error and slow-log rotations are written only when something happens, so old ones are sparse real events. The slow log opens with a blank line, and the backend error log dates lines Apache's way | each file's content dates over every line ([evidence.md](evidence.md#log-pulls)) | state the real coverage window per log type |

## Salts

`wp-config.php` usually requires the salts from `wp-salt.php`, and `wp core verify-checksums` always lists that file as unexpected. Older apps can define the salts in `wp-config.php` with an unused `wp-salt.php` beside it, so check which file holds them before rotating: `grep -n 'wp-salt' wp-config.php` and `grep -c "define( *'AUTH_KEY'" wp-config.php wp-salt.php`. Where the salts live in `wp-salt.php`, rotate with `wp config shuffle-salts --config-file=wp-salt.php`; a plain run adds a second set to `wp-config.php` ([hardening.md](hardening.md) has the rest of the rotation).
