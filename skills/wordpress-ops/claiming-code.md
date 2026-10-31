# Claiming abandoned code

For every theme, plugin, mu-plugin and drop-in that nobody you trust maintains: closed on wordpress.org, off-repo, unreleased for two years or more, changed hands, or carrying an unfixed vulnerability. Each gets one decision, and the owner's yes before anything is removed. Work against a snapshot and the rehearsal stack ([local-stack.md](local-stack.md)), never live. Tool pins and install lines are in [tools.md](tools.md).

## 1. Signals

`scan.ts` gathers most of these; fill the rest by hand, against the rehearsal stack or the throwaway restore, not live.

| Signal | Read from | Reading |
| --- | --- | --- |
| wordpress.org status | `curl -sg 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&slug=<slug>'` (themes: `themes/info/1.2/?action=theme_information`) | `"error":"closed"` arrives with `closed_date` and `reason`; `"Plugin not found."` means premium or off-repo. This API is the authority: scan data sources have flagged listed, updated plugins as closed |
| last release, `tested`, `requires_php` | the same response | two and four years since `last_updated`, or `tested` behind current core, are flags; vendor metadata never vouches for current core, the rehearsal does |
| vulnerabilities | `https://www.wpvulnerability.net/plugin/<slug>/` (also `/theme/`), keyless | filter by the installed version against each entry's affected range: a plugin listed as vulnerable can be past the fix and merely unmaintained, a reason to replace later, not now |
| owner | for a plugin, the API's `author_profile` (the owning account) against the previous scan's record, which `scan.ts` keeps in its `.json` sidecar; for a theme, the header's `Author` against the API's | a change is the ownership-change tripwire: read the first release under the new owner (step 2). The plugin API's `author` names the account, not the header's author, so comparing those two is noise. The first scan of a site has no previous record, so its plugins' owners start unverified |
| integrity | `wp plugin verify-checksums <slug>` for wordpress.org plugins; a diff against the vendor's pristine zip for premium code and every theme | a current version proves nothing on its own, and a clean update doesn't remove a payload that already ran (users, options, files it wrote stay) |
| origin of a premium zip | the vendor's documented download URL, then `file <zip>`, the header version, and a pinned SHA-256 | a GitHub "release asset" may not be the plugin at all. A theme can ship its companion plugin as a zip inside itself: unzip both and `diff -rq` against the installed copies |
| what it stores | `wp option list --search='<prefix>*' --fields=option_name,autoload,size_bytes`, `wp db tables '*<prefix>*' --all-tables`, `wp cron event list --fields=hook`, `meta_key` counts in usermeta, postmeta and termmeta, and indexes it added to core tables (`SHOW INDEX FROM <prefix>posts`) | the data a removal must archive, and what a replacement must keep reading (absorbed code can depend on an index the plugin created) |
| what references it | list what it defines (command below the table), then grep the theme, mu-plugins, widgets, theme options and `post_content` for each | a count per reference; a "useless" plugin can still be feeding the theme its colours, so a removal gets a render diff ([theme-upgrades.md](theme-upgrades.md#parity-in-both-directions)) |
| licence | the header's `License`; for a ThemeForest item, the `Licensing/` note in the purchased zip | decides whether a fork may ever be published (step 4) |

```sh
LC_ALL=C grep -rnE "add_shortcode|register_block_type|do_action|apply_filters|^function " <component>
```

Why the tripwire and the checksums run on current versions too: a portfolio of 22 wordpress.org plugins was backdoored after a sale through an ordinary "compatibility" release and closed on 2026-04-07; a plugin's commit access was hijacked to ship a pre-auth backdoor on `init`; a vendor's Pro update channel shipped malicious builds. Off-repo is a supply chain as well: in 2025 the download pipelines of Gravity Forms and of Groundhogg each served backdoored builds (manual downloads and Composer installs; the auto-update route stayed clean), so check the vendor's security notices against the installed version and ask where and when the copy was downloaded.

## 2. Read the code

Read every component nothing vouches for: every theme, and every plugin except a maintained wordpress.org release whose files match its checksums. A modified copy of a wordpress.org plugin is off-repo code, however old the original. `scan.ts` runs the triage patterns over each (`$triage_patterns` in `scripts/php/files.php` is the one list), then read each hit with its guard:

| Pattern | Read for |
| --- | --- |
| `wp_ajax_nopriv_` handlers, REST routes | what a visitor can trigger; `permission_callback` set to `__return_true` on a route that writes |
| dynamic calls built from request input | a handler that calls whatever function a POST field names is remote code execution |
| `unserialize` of input | object injection |
| `hash_equals` against a constant | a hardcoded token is a backdoor, whoever put it there |
| `eval`, `assert`, `create_function`, decode-then-execute chains | obfuscated payloads; vendors rarely need any of them |
| `all_plugins`, `pre_user_query`, `views_users` filters | code hiding plugins or users from wp-admin |
| login hooks, reads of `$_POST['pwd']` | a callback that keeps or sends the plain password is a credential skimmer; security and 2FA plugins hook the same filters to check it, not keep it |
| remote calls | what leaves the site, to which host, carrying what; a bare IP address for the host is a tell |
| file and capability writes | users created, capabilities granted per user, files written outside uploads |
| SQL built from input or escaped by hand | injection: only `$wpdb->prepare()` or an integer cast makes it safe, and escaping that runs before a decode lets an encoded quote through |
| request input printed raw | reflected XSS; values a visitor wrote that come back from the database (referers, names) print the same way and match no pattern |
| writes from request input with no nonce check | CSRF: any page a logged-in user opens can send the request |

A Semgrep pass ([tools.md](tools.md#static-analysis)) adds taint paths inside each function; it narrows the reading, never replaces it.

No pattern sees a missing capability check, an unvalidated redirect or a path traversal: read each handler for those.

- **Read the guard.** A visitor-registered handler that checks a nonce and a capability before acting is fine; one that checks only a nonce printed to every visitor isn't. A theme's data migrator guarded only by "logged in" lets any contributor rerun it and overwrite theme options.
- **Prove it harmlessly, locally.** Replay the request on the rehearsal stack as a visitor or a low-privilege user, with a harmless argument (`count`, a marker string). Never against live.
- **For a vulnerability**, find where the fix landed by diffing the releases either side of it, then judge whether that path is reachable on this site ([incident-response.md](incident-response.md)).
- **For a new owner's first release**, also read the bootstrap, the REST controllers, the permission class, `uninstall.php` and the JS, pin the zip's SHA-256 in the runbook, and prove the data survives its schema upgrade (row counts and a content hash before and after the first admin request).

Each finding gets one of three verdicts with `file:line` evidence: **confirmed**, **needs a human**, or **false positive** with the reason ([incident-response.md](incident-response.md#verdicts-and-the-record)). Say what wasn't read.

## 3. Disposition

| Disposition | When | How |
| --- | --- | --- |
| **remove** | nothing references it | archive its data, delete the code, drop the data last (below) |
| **replace with a few lines** | its whole job is one hook | count what the replacement must keep first: a one-line plugin that strips the HTML filter from user bios is the vulnerability, and its replacement keeps HTML bios only for users with `unfiltered_html`. A REST lockdown replacing a plugin is checked on `/wp-json/`, `/wp-json/wp/v2/users`, `/?rest_route=/wp/v2/users` and the oEmbed route, logged out and in |
| **absorb into the theme or a site mu-plugin** | small and site-specific | one site mu-plugin per site, each block with a one-line reason; the plugin goes once every field, option and index it covered is accounted for |
| **fork in place as a plugin** | it owns tables or an admin screen | step 4 |
| **keep the vendor code, patch from an mu-plugin** | premium code you shouldn't fork wholesale | `remove_action` the handler, or filter the feature off. Unhook on a hook that runs after the registration: a handler registered inside the theme's own `after_setup_theme` callback is unhooked on `init`. Verify that even an administrator with a valid nonce now gets `400 0` from `admin-ajax.php` |
| **move to the vendor's maintained release** | one exists | rehearse it, and treat its migrator as untrusted code ([theme-upgrades.md](theme-upgrades.md#the-vendors-migrator-is-untrusted-code)) |
| **keep, recorded** | unmaintained, no hole reachable, no cheap replacement | a line under "Decisions recorded as choices" in the workspace `CLAUDE.md` naming what would reopen it |

**Removing a plugin that holds data** runs in this order, each step after the owner's yes:

1. **Archive** its tables and option rows as an SQL dump, even when an export exists: an old CSV export of a subscriber table lacked one address and several columns. Verify from the dump itself: `gzip -t`, then count the rows it holds (restore it into a throwaway server, [evidence.md](evidence.md)) against live's `COUNT(*)`, never the export command's own output.
2. **Delete the code** with `wp plugin delete <slug>`, which skips `uninstall.php`, so the tables and options survive for a deliberate drop; a delete from wp-admin runs `uninstall.php` and drops them at once. Then remove its option rows by name.
3. **Drop the tables** after the owner confirms the archive, re-checking the live row count first (the site may have written since).

## 4. Fork hygiene

1. **Set `Update URI`** to `false` or to a URI on a domain you control. wordpress.org then offers no update for it; plugins honour the header from WordPress 5.8, themes from 6.1. A fork everyone believes isn't on wordpress.org can still hold a listed slug: check the API and `curl -sI https://downloads.wordpress.org/plugin/<slug>.<version>.zip` (a 200 means the slug exists). `update: none` in `wp plugin list` today proves nothing about tomorrow.
2. **Rename the folder too.** wordpress.org matches updates by folder slug, not by `Name`, and `wp plugin verify-checksums` checks a folder against whichever wordpress.org plugin holds that slug. A rename alone holds only until someone registers the new slug, and on core older than 5.8 (plugins) or 6.1 (themes) it is the only guard. Rehearse the rename:
   - plugin: deactivate the old slug, move the folder, activate the new one; activation hooks run again, so diff the table list and option names before and after
   - theme: theme mods live in `theme_mods_<folder>`, so copy `theme_mods_<old>` to `theme_mods_<new>` with the [byte-exact option copy](theme-upgrades.md#byte-exact-option-copy) before `wp theme activate <new>`. A child theme's `Template:` header names the parent's folder.
3. **Suffix the version** (`1.9.8-site.1`), so nobody mistakes it for a vendor release.
4. **Keep the licence and credit lines.** A ThemeForest item is split-licensed: the PHP and integrated HTML are GPL, while the CSS, images and design stay under the purchased licence. A private fork for the licensed site is fine; a public one needs those parts replaced.
5. **Record the code as owned** in the workspace `CLAUDE.md`: path, source folder in the workspace, upstream version it forked from, what was changed. Fixes land in that source first and deploy from it, so live never holds a change git lacks.
6. **Check drift in every audit and deploy by checksum.** `rsync -rcn --delete --itemize-changes <source>/ <ssh target>:<live path>/` prints nothing when live matches the source (a `*deleting` line is a file only live has). A deploy is `rsync -rc` without `-n` or `--delete`, after that dry run, so only changed files move.

Proven when a forced update check on the rehearsal stack offers nothing, the renamed component renders like the original, and the drift check prints nothing.

## 5. After the claim

The code is now yours, so run the checks for owned code on the rehearsal stack ([tools.md](tools.md) has pins and commands): PHPCompatibilityWP at the target PHP, PHPStan with the WordPress extension plus `wp-compat` and the deprecation rules, and Plugin Check's security checks (plugins only). Where WordPress/agent-skills' `wp-phpstan` skill is installed, load it for PHPStan setup. Each finding is fixed or classified ([upgrades.md](upgrades.md#auditing-for-a-target-php)).

**Save test.** A claimed metabox or settings screen runs its sanitizers on every save, so an unchanged save must leave the data byte-identical. A blanket `sanitize_text_field()` strips percent-encoded octets and tags, so `%20` vanished from download URLs and links from contact fields on every admin save, and `wp_kses_post()` turned a tracklist's `&` into `&amp;` that the template encoded again.

```sql
SELECT meta_id, meta_key, MD5(meta_value) FROM <prefix>postmeta WHERE post_id = <id> ORDER BY meta_id;
```

Run it, press Update on that post in wp-admin with nothing changed, run it again: the two outputs match. A mismatch gets a sanitizer per field (`sanitize_url()` for URLs, `wp_kses_post()` for HTML, plain text only where the field is plain text), with `wp_unslash()` on the input and `wp_slash()` into `update_post_meta()`. Restore the post afterwards from a checkpoint and delete the revisions the test made. Values already damaged on live come back from the newest dump taken before the damaging save (the post's `post_modified` dates it): restore that dump into a throwaway server, write that post's meta rows back, and compare MD5s with the dump's. Every field type must pass an unchanged save.
