# Incident response: contain, investigate, verdict

For a suspected or confirmed compromise, and for the security half of looking an inherited site over. The **as found** snapshot and the retained logs come first ([evidence.md](evidence.md)). Reading logs is [log-analysis.md](log-analysis.md). A campaign's own strings live as data in `scripts/ioc/` ([format](scripts/ioc/README.md)); this file teaches the classes they belong to.

## Containment: the order is the point

Each step stops a later one from undoing it.

1. **Close the entry without deleting anything.** Rename the plugin folder to `<slug>.disabled`, or, when the owner keeps the integration, disable only the entry point (mark the key inactive and replace its value, or refuse it from a one-line mu-plugin on the plugin's own validation filter). Revoking on the remote side (detaching the site in the vendor's dashboard, that account's password and 2FA) is the owner's step, written as plain instructions.
2. **Take the keys out before any plugin update.** A disabled plugin keeps its options, so reinstalling or updating it while the leaked keys are stored brings them back to life. Deleting those options also deletes the plugin's command log, often the best forensic record: decode it from the verified dump first ([dating without logs](#dating-without-logs)). Some integrations mint a fresh full-power key on the next `is_admin()` request when none exists, and `admin-ajax.php` satisfies `is_admin()` for any visitor: deleting the key from a plugin that stays installed hands out a new one. So remove the plugin, or prove it refuses old and new keys.
3. **Quarantine the implants**, each with a [manifest line](#manifest-lines), then sweep what they left ([excision](#excising-a-plugin-and-everything-it-left)). A modified core or wordpress.org plugin file gets its manifest line (the as-found copy is in the snapshot) and goes back to pristine in the same step: reinstall the component at its installed version (`wp core download --force --skip-content --version=<installed> --locale=<installed locale>`, `wp plugin install <slug> --version=<installed> --force`), then checksum again, which also lists anything left over. Premium code comes back from the vendor's pristine zip.
4. **Clear every persistence layer in one pass.** Footholds guard each other (a cron hook that rewrites a deleted file, an mu-plugin that reinstalls a plugin, an `auto_prepend_file` that loads before WordPress) and restore a removed piece within minutes. The layers are the [indicator classes](#indicator-classes); re-scan at least one cron cycle later.
5. **End the attacker's sessions.** Rotate the salts where they actually live ([hardening.md](hardening.md#7-salt-rotation)), which invalidates every login cookie. Revoke application passwords separately: they survive password resets and salt rotation.
6. **Purge what cached the incident.** A page cache that stored the implant's error pages keeps serving them; the layers are in [upgrades.md](upgrades.md#cache-layers).
7. **Draw up the credential inventory**: every secret the entry could read. A foothold that reads the database exposes every password hash and every token plugins store. List names and lengths in a throwaway restore, never values ([engagement.md](engagement.md#secrets)), and put each on the rotation list ([owner-handoff.md](owner-handoff.md)):

   ```sql
   SELECT option_name, LENGTH(option_value) FROM wp_options
   WHERE option_name REGEXP 'token|secret|key|pass|auth|licen|api|webhook|oauth|phrase'
   ORDER BY option_name;
   ```

   A foothold that runs PHP also reads `wp-config.php`: add the database password and every key defined as a constant, by name (`wp config list --fields=name,type`).

8. **Prove clean**: re-run `scripts/scan.ts`, then walk the indicator classes. Clean means every class has a result with its count, not that the scan's headline is quiet.

### Manifest lines

The site's quarantine root holds a `MANIFEST.txt` with one tab-separated line per item, written by the same command that moves it:

```sh
quarantine() {
  target=$Q/$(echo "$1" | tr / -)
  if error=$(mv "wp-content/$1" "$target" 2>&1); then destination=$target; else destination="left in place: $error"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" '<app>' "wp-content/$1" "$destination" "$2" | tee -a "$Q/MANIFEST.txt"
}
```

A database row can't be moved, so its quarantine is the verified dump that holds it, named on its line (`wp_options:<option_id>`, "row kept in dump `<stamp>`"). An item that couldn't move gets its line too.

## Investigating

Unordered; each feeds the verdicts.

- **Timeline:** logs plus the site's own records ([dating without logs](#dating-without-logs)), every event in UTC with its source, beside the stated log coverage. Include returns after containment: an attacker often comes back within hours, and a return that got the ordinary page and added no command-log entry reached nothing.
- **Database:** the [battery](#database-audit-battery) on a throwaway restore of the as-found dump, read-only, then on the post-containment dump, diffed.
- **Code nobody vouches for:** every mu-plugin, drop-in, docroot-level and above-docroot PHP file, every non-WordPress folder in the docroot, and every component nothing vouches for, read as [claiming-code.md](claiming-code.md#2-read-the-code) says. A scan that lists an mu-plugin as informational has not read it. Say what wasn't read.
- **What checksums can't see** ([below](#beyond-checksums)), and the [entry vector](#entry-vector).

## Indicator classes

Run WP-CLI with `--skip-plugins --skip-themes` throughout, so a hiding filter never runs.

| Class | Where it hides | Check |
| --- | --- | --- |
| Implant plugins | a folder with a plausible header, decoy asset files of a few bytes, an `uninstall.php` that deletes its own options; recent mtime; no wordpress.org record | `scripts/scan.ts` (off-repo, recent, pack hits); read the main file |
| Hidden plugins | an `all_plugins` filter drops it from the Plugins screen | `wp plugin list` under the flags above, against the folder listing |
| Hollow active plugins | a main file emptied in place (a host's malware cleaner) or a missing folder, still in `active_plugins`; with no header it is absent from `wp plugin list` | `wp option get active_plugins --format=json` against `wp plugin list --field=file`, and `test -s` on each active file, before anyone loads wp-admin (**as found**). The emptying mtime dates the cleaner, not the attacker |
| Hidden users | `pre_user_query` or list-table filters | SQL in the battery, never the admin screen |
| Capabilities granted per user | a capabilities row carrying `manage_options` or `install_plugins` beside its role; a role definition that gained capabilities | SQL in the battery |
| mu-plugins | load on every request, need no activation | read every file |
| Drop-ins | `advanced-cache.php`, `object-cache.php`, `db.php`, `install.php`, `maintenance.php` and the rest of core's list load even when the plugin that wrote them is inactive | `wp plugin list --status=dropin`; name each one's owner, or record it as unowned |
| Docroot and above-docroot code | non-core files at the docroot (a previous host's helper answering unauthenticated "does this path exist" POSTs), legacy non-WordPress folders served by the same PHP pool, PHP one or two levels up | core checksums cover core paths only: list the docroot against core's file list, and `find <docroot>/.. -maxdepth 2 -name '*.php' -not -path '<docroot>/*'` |
| `wp-config.php` | code after the `wp-settings.php` require; extra requires | read everything after `grep -n 'wp-settings.php' wp-config.php`, and every file it requires |
| `.user.ini`, `.htaccess` | `auto_prepend_file` runs a file before WordPress; a handler line makes an image extension execute | `find <docroot> \( -name .user.ini -o -name .htaccess \)`, then grep for `auto_prepend_file`, `auto_append_file`, `AddHandler`, `SetHandler`, `php_value` |
| PHP in uploads | uploads should hold none; PHP under an image extension | `find wp-content/uploads -name '*.php'`; `LC_ALL=C grep -rl '<?php' wp-content/uploads --include='*.jpg' --include='*.png' --include='*.gif' --include='*.ico'`. Benign hits exist (an `exit`-guarded debug log, `index.php` placeholders): triage each |
| Cron | hooks named after a plugin that's gone; a hook whose callback rewrites files | `wp cron event list --fields=hook,next_run_gmt,recurrence`, each hook mapped to core or a present plugin; `crontab -l` for every server user you can read |
| Shell rc files | `.bashrc`, `.profile` of server users | read them |
| Options holding code | widgets, theme mods, header and footer snippets | code markers in the battery; an analytics tag is explained, not skipped |
| Application passwords | survive password resets | `_application_passwords` usermeta |
| Session tokens | a login from the window | `session_tokens` usermeta (time, address, UA) against the security plugin's login records |
| Open REST routes and AJAX handlers | `permission_callback` set to `__return_true`; `wp_ajax_nopriv_` handlers in off-repo code | grep, then judge by what the callback does ([claiming-code.md](claiming-code.md)) |
| Credential skimmers | a login hook that copies the submitted password (and 2FA code) to a file, an option or a remote URL | `scripts/scan.ts` (login hook or password read), the same grep in [claiming-code.md](claiming-code.md); read each hit's callback |
| Remote-management keys | UpdraftCentral keys, WP Webhooks action keys, management-dashboard connections: authenticated control, so a stolen key looks like the owner | each integration's stored keys, and [its real switch](#integrations-read-the-real-switch) |
| Previous-host leftovers | single-sign-on mu-plugins that log in whoever presents a token matching a transient, docroot helpers, host-branded mu-plugins | read them; check whether the token they wait for exists |
| Cloaking | injected content served only to crawlers, or only at origin | fetch one URL as a crawler UA, as a browser UA, and at origin past the CDN (`curl --resolve <domain>:443:<origin address>`); diff the three |
| Core files | modified or extra files in core paths | `wp core verify-checksums --include-root` with the install's `--locale` ([tools.md](tools.md#integrity)). Extras can be benign: a downgrade's leftovers, a host's salts file |
| wordpress.org plugins | modified files | `wp plugin verify-checksums --all`; premium and custom plugins are skipped, which is where the risk sits |

## Database audit battery

Queries here write the prefix as `wp_`; read the real one from `wp-config.php`, and run every query on every table set in the database, since a dormant second install is a place to hide. Collect them into one `.sql` file and run it in one call (`docker exec -i <container> mariadb --table <database> < battery.sql`).

1. **Remote-management command logs**, decoded ([dating without logs](#dating-without-logs)).
2. **Users**: registered in the window; odd email domains (a site may give byline accounts placeholder addresses on purpose: ask); empty capabilities; capabilities granted per user. A row listing a role plus capabilities is a direct grant:

   ```sql
   SELECT u.ID, u.user_login, u.user_registered, m.meta_value
   FROM wp_users u JOIN wp_usermeta m ON m.user_id = u.ID AND m.meta_key = 'wp_capabilities'
   WHERE m.meta_value REGEXP 'manage_options|install_plugins|edit_plugins|edit_users|promote_users';
   ```

   Then decode the `wp_user_roles` option and confirm only `administrator` carries those capabilities.

3. **Access grants**: `_application_passwords`, `session_tokens`, and `user_activation_key`, whose epoch prefix dates each reset request.
4. **Core options**: `siteurl`, `home`, `admin_email`, `users_can_register`, `default_role`, `template`, `stylesheet`, `active_plugins`.
5. **Recent options**: the newest 30 by `option_id` (auto-increment, so it orders writes); options named after a missing plugin; options matching a pack.
6. **Cron**: every hook mapped to core or a present plugin.
7. **Code markers**: `<script`, `<iframe`, `eval(`, `atob(`, `fromCharCode`, `document.write`, `base64_decode`, `gzinflate` in posts, postmeta, termmeta, commentmeta, usermeta and options. Tally every external `src` domain: social embeds are expected, an unknown domain is a finding.
8. **Content in the window**, by `post_date_gmt` and `post_modified_gmt` (the plain columns follow the site's timezone).
9. **Tables**: each non-core table attributed to a plugin, present or past.
10. **Security records**: the security plugin's login and hit tables and a redirection plugin's 404 log, each with its first and last date, then their rows in the window.
11. **Indicator sweep** of the whole dump: `gzip -dc db.sql.gz | LC_ALL=C grep -c '<indicator>'` for every pack string and the incident's own addresses.
12. **Diff by primary key** between the as-found and post-containment restores (`options`, `users`, `usermeta`, `posts`, `postmeta`, `comments`): per table, `SELECT <key>, MD5(CONCAT_WS(0x1f, <columns>))` on each, then `diff`. Expected changes have names: core dropping a missing plugin from `active_plugins`, cron rescheduling, spam housekeeping, the dashboard's events widget rewriting a user's location meta. Rows shorter by multiples of 3 bytes with an unchanged modified time are the utf8 dump defect ([evidence.md](evidence.md#verified-dumps)), not an edit.

## Dating without logs

Server logs keep weeks. A compromise found months late is dated from what the site stores about itself: read each source's first and last date, then list which reach the window.

| Source | What it dates |
| --- | --- |
| a remote-management command log (UpdraftCentral keeps its last 50 in `updraftcentral_client_log`) | each command with time, remote address and UA |
| folder and file mtimes | an implant folder's mtime is its upload; every file of a plugin sharing one mtime is a rewrite through an update command, which also makes mtimes useless for verifying that plugin; a file emptied in place dates the cleaner |
| `option_id` and other auto-increment ids | the order of writes |
| ids that encode time | a Discord webhook id is a snowflake, `(id >> 22) + 1420070400000` milliseconds; integrations often store `date_created` |
| `auto_core_update_notified`, `db_version`, `initial_db_version` | the last core auto-update mail; the bracket of the site's core history |
| `user_activation_key`, a security plugin's last-login usermeta | a reset request; a user's last good login |
| security plugin tables | their first and last rows bound what they can show |

Decode a serialized option without allowing objects, since unserializing attacker-touched data with classes allowed is object injection:

```sh
docker exec restore-test mariadb -uroot -prestore -N --raw restore \
  -e "SELECT option_value FROM wp_options WHERE option_name = '<option>'" |
  php -r 'echo json_encode(unserialize(rtrim(stream_get_contents(STDIN), "\n"), ["allowed_classes" => false]), JSON_PRETTY_PRINT), "\n";'
```

Reading a command log: the owner's own dashboard sends a versioned client UA with the vendor's URL; decrypt failures and "not understood" notices from many addresses are keyless spraying that ran nothing; a probe followed by a command from one address is a working key. The log is only as trustworthy as the site: say whether code that ran could have rewritten it.

Three clocks disagree: the Mac's `stat` prints local time (`TZ=UTC stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' <file>`), the server's `find -printf` uses the server's zone, and the plain database columns use the site's `timezone_string`. Write every time in UTC.

## Beyond checksums

- **Premium plugin with a free twin:** fetch the free release's checksums (`https://downloads.wordpress.org/plugin-checksums/<slug>/<version>.json`, mapping the premium numbering to the free version), compare MD5s of the shared files, and read the files that differ. A genuine build differs only in its header, autoloader, translation template and premium-only folders.
- **Premium code without a twin, and every theme:** diff against a pristine copy of the same version from the vendor.
- **Closed wordpress.org plugin:** its checksums and SVN tags stay readable after closure; verify and diff as usual.
- **Supply chain:** run checksums and signature scans whatever the version, since an up-to-date plugin can be the backdoored one ([claiming-code.md](claiming-code.md)). A clean update doesn't remove a payload that already ran: audit the window even after updating.
- **Signature scan:** YARA rule sets over a copy's `wp-content/` ([tools.md](tools.md#malware-scanning)), as one layer among these.

## Entry vector

Rule each candidate in or out with the check that settles it, or record it as unknown with the evidence that's missing:

- **a stolen credential or key**: authenticated commands in an integration's log, no failed authentication anywhere
- **a vulnerable component**: core against GitHub's advisories and KEV, plugins and themes through WPVulnerability ([tools.md](tools.md)). Judge reachability by diffing the releases either side of the fix, then checking whether that path runs here (component active, feature configured, which hook reaches it)
- **an unauthenticated handler in premium code**: the triage patterns in [claiming-code.md](claiming-code.md)
- **a previous host's leftovers**
- **a compromised update or download** ([above](#beyond-checksums))
- **a script served to wp-admin from a vendor's CDN**: it runs in an administrator's browser and acts through their session, so nothing lands on disk until it creates a user or uploads a plugin, and checksums stay clean. The [admin-session sweep](log-analysis.md#routine-sweeps) shows the first footprint coming from an owner's session and address with no failed login before it; then list the off-site scripts the admin screens load

## Integrations: read the real switch

A summary option ("active webhooks: none") can be deprecated and ignored by the code. Before rating an integration dormant, trace its request handler: which hook it runs on (on `init`, it answers at any URL), what a key can do (create users, write files, install plugins, send mail), whether an address limit exists in this edition. A finding this alarming goes to a fresh agent given only the claim before it reaches the operator. When the owner deletes such a plugin in wp-admin, its options, postmeta and tables stay behind and a reinstall revives the old key: sweep them as below.

## Excising a plugin and everything it left

1. **Dry run**, read-only, names and counts only: options with the plugin's prefixes (its own, its transients, its remote protocol's, its update checker's), usermeta with those prefixes, its cron hooks, its folder and data folder under `wp-content/`, `active_plugins` entries whose folder is missing or whose main file is empty or headerless, and **orphans**: any option or cron hook named after a plugin (hyphens as underscores) still listed active or holding a token while its folder is gone. Matching known names alone missed a working implant's install-time option and daily cron hook; the orphan rule caught them.
2. **Compare with the database audit**, and check each prefix against installed plugins so a live plugin's options don't match.
3. **Apply** after approval, through WordPress's own functions (`delete_option`, `wp_clear_scheduled_hook`, `delete_metadata`, `update_option` on `active_plugins`) and `mv` for folders, each with its manifest line.

The sweep deletes the plugin's command log, so the dump taken before it is the only copy: the decode must already be in the record.

## The remote-management-key campaign

The class: a valid remote-management key drives the site's own control endpoint. The requests authenticate, so there are no failed logins, no exploit signature and nothing for a firewall to catch; the site's own command log is the record. Indicators: `scripts/ioc/updraftcentral-2026.json`.

- **Shape:** keys made years earlier for a vendor's dashboard leaked on the vendor's side; the attacker probed each key, then sent one upload-plugin command per site, with activation riding on the upload. The implant hooks `init`, compares a GET parameter with a stored token through `hash_equals`, creates an editor granted `manage_options` and `install_plugins` directly, logs it in, and hides itself and its user with `all_plugins` and user-query filters.
- **Variants:** builds that fatal on every request (the outage is the alarm), a working build whose trigger appears in no log, and one emptied in place by a host's cleaner, left active, headerless and invisible to `wp plugin list`.
- **Noise:** the same plugin's keyless vulnerability draws months of spraying; its decrypt failures in the command log ran nothing.

| Trace | Found by |
| --- | --- |
| the outage | the critical error page, then the PHP error log naming the plugin path |
| attacker requests | the pack's user agent in access logs, then the command log in each dump |
| sync tokens and stale `active_plugins` entries | `scripts/scan.ts` |
| the working build's install option and cron hook | the database audit, after a first excision missed them |
| the emptied implant | the command log plus folder mtimes; every tool missed it |
| a previous host's single-sign-on mu-plugin (pre-existing, separate) | reading every mu-plugin and root file |

## Owner access after containment

- Before calling a locked-out owner account hijacked, check its email, last good login and 2FA enrolment date: a lost authenticator explains most lockouts.
- Wordfence gives administrators no 2FA grace period, so deleting a user's 2FA secret alone locks them out. Delete the secret, then set the usermeta `wfls-allow-grace-period`, `wfls-grace-period-reset` (now) and `wfls-grace-period-override` (days), and tell the owner the deadline. Clearing the role requirement isn't enough, since Wordfence caches it.
- "Verification required, check your email" right after a reset is Wordfence's reCAPTCHA step for a low score (a VPN does it): the owner clicks the emailed link.

## Verdicts and the record

Every finding gets one verdict and its evidence:

- **confirmed**: the attacker's, or exploitable here, with `file:line`, a row id or a log line, and its state: active, inert, or removed (its manifest line)
- **needs a human**: the evidence can't settle it; name who can
- **false positive**: with the explanation that clears it (the owner's analytics tag in a header option, byline accounts on a placeholder domain, the host's salts file in core checksums)

**No sign of misuse** names the sources, their span and counts, and what they can't show (POST bodies; read-only abuse such as listing users with their hashes writes nothing). **Unknown** when the evidence is gone, and everything it touched is treated as exposed. Describe behaviour, never who might be behind it.

The record (`docs/incident-<date>.md`): attack (mechanism, then a UTC timeline with sources), containment (each step with its time and snapshot stamp), returns after containment, cleanup, what was checked with counts and verdicts, credentials exposed, evidence (stamps, archive paths, what each still holds), open items with their holders. Recovery goes to the owner through [owner-handoff.md](owner-handoff.md).
