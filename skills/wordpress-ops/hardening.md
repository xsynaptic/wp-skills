# Hardening

Closing the exposures an inherited site carries, whether or not anyone used them. On **the owner's site** most items are the owner's call: each is applied after approval, or recorded as their choice under "Decisions recorded as choices" in the workspace `CLAUDE.md` with what would reopen it; owner steps go in the owner message ([owner-handoff.md](owner-handoff.md)). Take what fits the site; the items are a menu, not a sequence.

Proving something gone from the web reads the cache headers (`age`, `x-cache`, `cf-cache-status`) as well as the status: a deleted script answered 200 from the proxy cache for hours, and a deleted stylesheet stayed on the CDN edge until purged.

## 1. Remote-management keys

Any plugin that lets another server run commands on the site is a standing key: UpdraftCentral (`updraft_central_localkeys`), WP Webhooks action keys, management-dashboard child plugins. A key leaked years ago still works.

```sh
wp plugin list --fields=name,status,version --skip-plugins --skip-themes
wp option list --search='*central*' --fields=option_name,size_bytes --skip-plugins --skip-themes
```

Repeat the option search with each remote-management plugin's own prefix.

Remove what the owner doesn't use, following [incident-response.md](incident-response.md) for the order (deleting a key can mint a new one). Jetpack stays if the owner uses it, and its keys are renewed by reconnecting (rotation list).

## 2. Users and capabilities

```sh
wp user list --role=administrator --fields=ID,user_login,user_email,user_registered --skip-plugins --skip-themes
wp db query "SELECT COUNT(*) FROM <prefix>users" --skip-plugins --skip-themes
wp db query "SELECT user_id, meta_value FROM <prefix>usermeta WHERE meta_key = '<prefix>capabilities' AND meta_value NOT REGEXP '^a:1:[{]s:[0-9]+:\"[a-z_]+\";b:1;[}]$'" --skip-plugins --skip-themes
```

The SQL count must match the Users screen: a `pre_user_query` filter hides a user there and from any WP-CLI run that loads it, never from SQL. The third query lists every capabilities row other than one plain role (extra roles, an empty array, per-user grants): capabilities granted per user are how a backdoor account gets `manage_options` while showing as an editor. Accounts that no longer write are the owner's to prune; bulk accounts that exist only as bylines are expected.

## 3. Application passwords

They survive password resets, so a reset alone doesn't lock out whoever made one.

```sh
wp db query "SELECT user_id, LENGTH(meta_value) FROM <prefix>usermeta WHERE meta_key = '_application_passwords'" --skip-plugins --skip-themes
wp user application-password list <user> --fields=uuid,name,created,last_used --skip-plugins --skip-themes
```

Each one is either known to the owner or revoked (`wp user application-password delete <user> <uuid>`).

## 4. Leftovers from previous hosts

A site migrated from another host often carries that host's mu-plugins and docroot files, still live: a single-sign-on mu-plugin that logs in as the first administrator whoever presents a token matching a stored transient, a docroot script that tells an unauthenticated POST whether a path exists, vendor mu-plugins for a dashboard nobody uses.

```sh
wp core verify-checksums --include-root --skip-plugins --skip-themes
ls -la wp-content/mu-plugins/ && head -n 30 wp-content/mu-plugins/*.php
```

`--include-root` warns about non-WordPress items in the docroot; read every one, and every mu-plugin. Quarantine after a snapshot, then prove each is gone from the web: the docroot file 404s, and `admin-ajax.php` answers `400 0` for an action the removed code registered.

## 5. Dormant dangerous plugins

An inactive plugin doesn't run through WordPress, but its PHP files still answer when requested directly (so do those of a forgotten app whose WordPress errors on load), and one click reactivates it. Rank the inactive list for the owner's removal:

1. dangerous if reactivated: development plugins that accept real passwords over HTTP Basic auth, `.htaccess` editors, file managers, anything with a remote-management key
2. closed on wordpress.org or carrying an unfixed vulnerability ([claiming-code.md](claiming-code.md))
3. the rest, plus all default themes but one current fallback

Removals happen in wp-admin on the owner's yes, or by quarantine on their approval.

## 6. Web-readable leftovers and dev tools

Backup-plugin folders, user exports (a CSV of logins, emails and password hashes), copies of old plugins, config backups (`wp-config-bak.php` with live credentials), debug scripts (a public hit counter writing its own log), debug logs, dumps and archives sit under the docroot. A PHP log guarded by `exit` still holds what it logged.

```sh
find . -type f \( -iname '*.sql' -o -iname '*.sql.gz' -o -iname '*.zip' -o -iname '*.tar*' -o -iname '*.bak' -o -iname '*-bak.*' -o -iname '*.old' -o -iname '*.csv' -o -iname '*.log' \) \
  -not -path './wp-content/cache/*' -printf '%TY-%Tm-%Td %s %p\n' | sort
```

Dev tools don't belong on a production site: Query Monitor or a similar plugin active, Xdebug loaded. The CLI's `php -i` says nothing about the web pool, so read PHP settings from the web side: a probe at the docroot with a random name (`<?php echo extension_loaded('xdebug') ? ini_get('xdebug.mode') : 'off';`), fetched once, then deleted and shown to 404. A host panel toggle for Xdebug can need its own save before it takes; the probe confirms it.

Test reachability; a folder's `.htaccess` proves nothing, since nginx serves static files without reading it, while some hosts block whole folders at nginx. Three HEAD requests settle it:

```sh
for target in '<folder>/<real file>' '<folder>/no-such-file-<random>.txt' 'wp-content/themes/<theme>/style.css'; do
  curl -sI "https://<domain>/$target?nocache=$RANDOM" | head -n 1
done
```

A 200 on the real file means exposed. The same 403 for the real and the nonexistent file, beside a 200 on the theme file, means a folder block. Quarantine exposed files either way, after approval, and add a `.gitignore` rule so the file never lands in a mirror.

## 7. Salt rotation

Rotate once the other changes are live (after the PHP switch, on an upgrade), together with the owner's password changes, so everyone signs out once. It is not urgent: since WordPress 4.0 a login cookie must also match a session token stored hashed in usermeta, so stolen salts plus a database copy don't easily forge a login. The password hashes in that copy, open to offline cracking, matter more.

1. **Dependency audit.** Find what keys off the salts before changing them: `grep -rnE "AUTH_KEY|SECURE_AUTH|LOGGED_IN|NONCE_KEY|wp_salt\(|wp_hash\(|openssl_encrypt|sodium_crypto" wp-content/plugins wp-content/themes wp-content/mu-plugins`, then find each hit's real key source and check the dump for non-empty values. Wordfence 2FA and Really Simple Security keep their own keys; W3 Total Cache marks encrypted settings `enc:v1`; a Jetpack connection survives. Each hit is shown to lose nothing, or the loss goes in the owner message.
2. **Find where the salts live.** `wp config shuffle-salts` edits `wp-config.php`, so where the salts are defined in a separate required file a plain run plants a second set. Count definitions per file (`grep -c "define( *'AUTH_KEY'" <each config file>`) and pass `--config-file=<file>` for the one that holds them (the host runbook has its layout).
3. **Rehearse on a copy of each layout.** The command rewrites CRLF line endings as LF, so compare with `diff --strip-trailing-cr`.
4. **Rotate live**, after approval.

Expect everyone to be signed out, Wordfence "new device" emails on the next administrator logins, and any form open during the rotation to fail once; the owner message says so. Afterwards exactly one file defines each salt.

## 8. `DISALLOW_FILE_MODS`

It costs more than install rights. With the constant set, administrators lose installing, uploading and deleting plugins and the file editors; WP-CLI still installs and updates; background updates stop unless a must-use plugin re-allows them:

```php
add_filter('file_mod_allowed', fn($allowed, $context) => 'automatic_updater' === $context ? true : $allowed, 10, 2);
```

What it buys: a remote-management upload checks `install_plugins`, so a leaked key can no longer become code. Preconditions: an update routine through WP-CLI, and the owner's removals done first, since deletes are blocked too. Where the owner runs their own updates in wp-admin, record it as their choice.

## 9. Update policy and two-factor login

- **Updates:** record who runs updates and how often; without a routine, the owner message carries a monthly check. Auto-updates are set per plugin with the reason beside each: manual for a plugin whose hooks owned code uses (minor releases drop deprecated hooks, [upgrades.md](upgrades.md)) and for one fresh off a rewrite that changed its markup or settings; on for the rest. A cache plugin is the judgement call: one minor broke its Redis auth and proxy purge on a managed host, while the releases around it carried several security fixes. Plugins pinned below their newest release keep the reason beside the pin.
- **Two-factor login:** read the security plugin's settings for who is enrolled and any grace period about to end; a lapsed grace period blocks the login until an administrator resets it, so give the owner the date. Offered, and required only where the owner chooses it; recovery exists over SSH.

Both go in the workspace `CLAUDE.md`.

## 10. REST, XML-RPC and enumeration

```sh
curl -s "https://<domain>/wp-json/wp/v2/users" | jq -r '.[].slug'
curl -s "https://<domain>/?rest_route=/wp/v2/users" | jq -r '.[].slug'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://<domain>/xmlrpc.php"
```

User slugs from the REST API are login hints, and a block on `/wp-json/` alone misses the `?rest_route=` form. XML-RPC carries brute force and pingbacks. Jetpack needs XML-RPC, so where it is connected restrict authentication through the security plugin rather than blocking the file. Each is the owner's choice with that trade-off.

## 11. Login controls: check the edge first

Before proposing a CDN challenge, rate limit or moved login for wp-admin, request the login URL and the moved slug: a 302 to an access gate (Cloudflare Access) means the edge already gates it, and a moved slug makes `wp-login.php` answer 404 by design.

## Server rules on self-managed hosts

On a managed host these sit with the host; check them with item 6's HEAD requests. On a server you run, the WordPress-level rules are three (no PHP under uploads; no dotfiles, dumps or backup copies; the real client IP behind a CDN); everything else (firewall, SSH, TLS, off-server backups, deploys) belongs to `vps-devops`: call the Skill tool with "vps-devops".

```nginx
location ~* ^/wp-content/uploads/.*\.(php|phtml|phar)$ { deny all; }
location ~ /\.(?!well-known/) { deny all; }
location ~* \.(sql|sql\.gz|bak|old|orig|swp|log)$ { deny all; }
set_real_ip_from <each CDN range>;
real_ip_header CF-Connecting-IP;
```

```apache
<Directory "<docroot>/wp-content/uploads">
  <FilesMatch "\.(php|phtml|phar)$">
    Require all denied
  </FilesMatch>
</Directory>
<FilesMatch "\.(sql|sql\.gz|bak|old|orig|swp|log)$">
  Require all denied
</FilesMatch>
<LocationMatch "/\.(?!well-known/)">
  Require all denied
</LocationMatch>
RemoteIPHeader CF-Connecting-IP
RemoteIPTrustedProxy <each CDN range>
```

- nginx: put the three `location` lines above the server's `location ~ \.php$`; regex locations match in file order, so below it the PHP handler wins and uploads PHP runs.
- Apache: the rules go in server config, not an uploads `.htaccess`: where `AllowOverride` lacks `AuthConfig`, a `Require` there answers 500 for every upload. `LocationMatch` covers dot-directories such as `.git/`, which a `FilesMatch` on the file name misses.
- Apache: Debian ships `mod_remoteip` disabled (`a2enmod remoteip`), and only the last `RemoteIPHeader` read counts, so `grep -R RemoteIPHeader /etc/apache2/` for an earlier one (the official WordPress image sets `X-Forwarded-For`).

Zips in uploads are often content people download, so they aren't on the deny list. Without the real IP, the security plugin's lockouts and the logs see edge addresses, and one lockout blocks a whole CDN node. Keep the ranges current the way `vps-devops` keeps its Cloudflare allowlist. Proven when a harmless PHP file planted in uploads answers 403, a `.sql.gz` file and `.git/config` answer 403, an image in uploads still answers 200, and the security plugin's live traffic shows visitor addresses.
