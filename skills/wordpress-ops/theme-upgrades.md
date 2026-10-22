# Theme upgrades

Moving a site to a new theme release, switching themes, or removing a plugin the theme leans on. The visible risk is a fatal; the real one is a site that renders without error and looks wrong on pages nobody checks. **Rehearse** on the copy with a before copy beside it ([local-stack.md](local-stack.md#checkpoints-and-the-before-copy)). Patching an old theme for a new PHP is the audit in [upgrades.md](upgrades.md#auditing-for-a-target-php); renaming or forking one is [claiming-code.md](claiming-code.md).

## Staging the package

Unpack the vendor zip outside the docroot and pin its SHA-256 in the runbook. ThemeForest themes ship their companion plugin as a zip inside the theme (`inc/extensions/*.zip`): unzip both, `diff -rq` against any earlier extraction, and pin both hashes. Keep the slug, so theme mods, menus and widgets stay attached, and quarantine the old folder rather than overwriting it.

## The vendor's migrator is untrusted code

List every write it makes: the keys it adds, whether it deletes anything, which old keys it overwrites, and whether live already holds the value it writes. That list, not the rehearsal's success, sets the rollback level: swap the files back (when the old version ignores the new keys), or restore the snapshot taken right before. Then:

- **Read its handler's guard.** A migrator any user with `edit_posts` can rerun overwrites edited options with old values. Once its counts are confirmed, unhook it from the site mu-plugin and check that even an administrator with a valid nonce gets `400 0`.
- **Memory:** `admin-ajax.php` doesn't raise the memory limit the way wp-admin pages do (`wp_raise_memory_limit( 'admin' )` runs in `wp-admin/admin.php` only), so the pool's own limit applies, and a migrator that peaks above it dies halfway. Measure the peak locally and read the effective limit from inside WordPress before the live run.
- **Time:** live can run it several times slower than the rehearsal, and a reverse proxy's timeout can cut the request before PHP's: send it with `curl -m 600` and confirm by counts afterwards.
- **Nonces:** an admin page carries several; the handler checks the one in its own `wp_localize_script` object. A wrong nonce or page slug can return an empty 200 having written nothing.
- **Counts:** count what it should produce before running it, minus rows already holding new-format keys from an earlier attempt, or the counts overstate its progress.

## Parity in both directions

A new major can obey settings the old one ignored: per-post layout meta left by an earlier attempt took the sidebar off years of older posts. It can drop settings the old one read: a renamed font-size option shrank the body text. Neither shows on the home page or the newest post, so an owner's look at the home page passes both.

1. Save the old theme's options with the [byte-exact copy](#byte-exact-option-copy): `theme_mods_<stylesheet>`, the theme's own option and `sidebars_widgets`. The old theme can't read the new format on rollback.
2. Diff those options and widgets between the before copy and the changed one (`wp option get <option> --format=json | jq -S .` on each side), and count the theme's per-post meta by publication year (`SELECT YEAR(p.post_date), m.meta_key, COUNT(*) FROM <prefix>postmeta m JOIN <prefix>posts p ON p.ID = m.post_id WHERE m.meta_key LIKE '<theme prefix>%' GROUP BY 1, 2`).
3. Render one post or page from every era of the site, the archives and the home page at desktop and phone widths on both copies. Full-page screenshot heights per page type are a cheap tripwire; then compare computed styles element by element (body text, headings, post title, byline, sidebar, buttons) and find the rule and setting behind each difference. Scroll pages whose blocks animate into view first, or those blocks come out blank.
4. A pass that finds no difference must still show the change you made (the swapped template's markup in the HTML), or it rendered a cached file ([local-stack.md](local-stack.md#workaround-catalogue), OPcache).
5. A probe post shows what new content gets by default; an archived capture of the live site shows what visitors saw before.

Every difference ends up restored, intended and signed off, or left to the owner as Theme Options work. Removing a plugin that looks useless gets the same computed-style check: one compiled the theme's LESS, and without it the brand colours fell back to defaults.

## Byte-exact option copy

A JSON round trip turns whole-number floats into integers, so a save through `wp option get --format=json` comes back different. Copy the row in SQL instead (on the rehearsal stack, through `docker compose exec -T db mariadb`):

```sh
copy_option() {
  wp db query "INSERT INTO <prefix>options (option_name, option_value, autoload) SELECT '$2', option_value, autoload FROM <prefix>options WHERE option_name = '$1' ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)" --skip-plugins --skip-themes
  # The SQL write bypasses the object cache
  wp cache flush --skip-plugins --skip-themes
  wp db query "SELECT option_name, MD5(option_value) FROM <prefix>options WHERE option_name IN ('$1', '$2')" --skip-plugins --skip-themes
}
copy_option theme_mods_<stylesheet> theme_mods_<stylesheet>__rollback   # save; restore with the arguments swapped
```

Both rows print the same hash. Delete the `__rollback` rows once the step is final.

## Live

- The switch's sub-steps (companion plugin, folder swap, migrator, option writes) run back to back, then every cache layer is purged at once ([upgrades.md](upgrades.md#cache-layers)): between them visitors see a half-changed site.
- After a theme change, re-derive the smoke routes and markers from the new code ([local-stack.md](local-stack.md#smoke-targets)).

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| The options table grows fast after a switch, only on live | a theme helper caches each listed post's remote stats as a transient, and without a persistent object cache transients land in the options table | `SELECT LEFT(option_name, 30) AS prefix, COUNT(*), ROUND(SUM(LENGTH(option_value)) / 1048576, 1) AS mb FROM <prefix>options GROUP BY prefix ORDER BY mb DESC LIMIT 10` | the theme's filter off in the site mu-plugin, `wp transient delete --expired`, recheck after a few minutes |
| Pages mix old and new styling | the proxy and CDN still hold the old pages and stylesheet | `age`, `x-cache` and the stylesheet's `ver=` in served HTML | purge the plugin cache, then the proxy, straight after the switch |
