# Evidence: dumps, snapshots, logs, archives

Getting a site **as found** onto local disk in a form you can trust, and proving a restore point restores. `scripts/snapshot.ts` implements the snapshot rules here; this file says what it checks and why, so a manual run on another host checks the same things.

What a first look needs: a verified dump, the docroot, and the current logs. A suspected compromise adds, the same day: every retained log (`--all-logs`; retention shrinks daily), the rest of the account ([below](#beyond-the-docroot)), uploads at least once (`--with-uploads`), and a read-only as-found archive ([below](#archives)). When the snapshot finds neither an `X-Powered-By` header nor a cached dashboard check, the manifest holds no served version: read it where the host runbook says and record it.

## Verified dumps

```sh
wp db export - --default-character-set=utf8mb4 --single-transaction --quick --skip-plugins --skip-themes | gzip -c > db.sql.gz
```

```sh
gzip -dc db.sql.gz | head -n 40 | grep 'SET NAMES'
gzip -t db.sql.gz && gzip -dc db.sql.gz | tail -n 1
gzip -dc db.sql.gz | LC_ALL=C grep -c '^CREATE TABLE'
wp db query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'" --skip-column-names --skip-plugins --skip-themes
```

The header names `utf8mb4`, the last line reads `-- Dump completed on …`, and the dump's table count equals live's: a dump is not a backup until all three hold.

| Tell | Cause | Detection | Fix |
| --- | --- | --- | --- |
| Header says `SET NAMES utf8`; emoji in the dump are `?` | WP-CLI 2.12 hands `DB_CHARSET 'utf8'` to the dump tool and upgrades it to utf8mb4 only when exactly one table matches `%\_posts`. A second table set (a dormant install, a stray prefix) returns two rows, and the dump silently falls back to 3-byte utf8 | `wp db query "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE '%\\_posts'"` returns more than one row; a primary-key diff of two dumps shows rows shrinking by multiples of 3 bytes | pass `--default-character-set=utf8mb4` on every export, manual ones included. A bad dump can't be repaired: take a new one, and keep a bad as-found dump labelled as such beside it |
| A mysqldump option like `--no-create-info` fails through `wp db export` | WP-CLI rewrites `--no-<flag>` as `--<flag>=` | the error names the mangled flag | avoid negated flags, or run the dump tool directly |
| Dump looks fine; nobody has restored it | the checks count tables, not rows | the restore test below | restore before calling it a backup |

## Restore test

Restore into a throwaway server of the live version, with no published ports:

```sh
docker run -d --name restore-test -e MARIADB_ROOT_PASSWORD=restore -e MARIADB_DATABASE=restore mariadb:<live version>
gzip -dc db.sql.gz | docker exec -i restore-test mariadb -uroot -prestore restore
docker exec restore-test mariadb -uroot -prestore -N restore -e 'SHOW TABLES' | while read -r table; do
  printf '%s\t%s\n' "$table" "$(docker exec restore-test mariadb -uroot -prestore -N restore -e "SELECT COUNT(*) FROM \`$table\`")"
done > restored-counts.tsv
```

Produce the same list on live in one SSH call with `wp db query`, then `diff` the two. `information_schema.tables.table_rows` is an estimate for InnoDB, so count with `COUNT(*)`. Also confirm what the dump's options assume: every table InnoDB (`SELECT engine, COUNT(*) … GROUP BY engine`), since `--single-transaction` is consistent only for InnoDB and MEMORY tables come back empty; and no routines or events (`information_schema.routines`, `.events`), which need `--routines --events`.

Every table's count matches, or differs only where live wrote since the dump (sessions, transients, logs), each named.

## Snapshots

- **Order:** manifest (core, plugins with active flags, themes, the served PHP read from the web side), then the dump, then logs, then the docroot. Dump first, so a long uploads pass can't leave an app without one.
- **Junk:** look before excluding anything (`du -xh -d 3 <docroot> | sort -h | tail -n 30` on the server). Resized image copies stay, so a restore needs no thumbnail regeneration; backup-plugin folders hold old dumps and logs naming backup sets, so they are evidence and secrets at once: in the as-found archive, out of mirrors. A dry run (`rsync -an --itemize-changes`) against the server confirms nothing expected is missing.
- **Before every risky boundary**, ask what restoring the newest snapshot would undo. If it would also undo work you mean to keep (a plugin batch's database changes, before a theme switch), take another snapshot first. Each runbook step names the stamp it rolls back to.
- **Stamps, never `latest`,** in done criteria, runbooks and reports: `latest` moves with the next snapshot, so "latest has uploads" stops being true. Read a stamp's `manifest.json` to know what it holds.

## Hard links and clones

| Copy | An edit reaches its siblings | Disk cost | Use |
| --- | --- | --- | --- |
| snapshot built with `--link-dest` | yes: unchanged files share one inode across snapshots | changed files only | the snapshot series, read-only by convention |
| `cp -cR` (APFS clone) | no, copy-on-write | none until edited | working copies, archives, replicas |
| `rsync -a` without `--link-dest` | no | full | another volume |

Build, mount or edit only a copy. Move snapshot folders with `mv` on the same volume; `cp` or a cross-volume move splits the links and balloons the size. Check with `stat -f '%i %l' <file>` (Linux: `stat -c '%i %h'`): a working copy shows link count 1.

## Case-insensitive volumes

macOS volumes are case-insensitive (and normalization-insensitive) by default, while the server keeps `Photo.JPG` and `photo.jpg` apart. rsync writes both names to one local file, so the visible file can hold the other file's bytes, and restoring from that copy swaps the images.

- **Detect** on the server before pulling: `find . ! -type d | sort -f | uniq -Di`. Check the local volume with `diskutil info <mount> | grep -i personality`.
- **Fix:** store each twin as `<name>.case-<n>.<ext>` with a `case-collisions.md` index of `mv -n` lines and `sha256sum -c` lines that put the exact names back on a case-sensitive host; `scripts/snapshot.ts` does this. Directories that differ only by case can't be stored that way: pull into a case-sensitive disk image (`hdiutil create -fs 'Case-sensitive APFS' -size <n>g <file>`) instead.
- A completeness check then expects exactly those names to differ.

## Log pulls

Snapshots carry only the current and previous day's logs; the host keeps rotations for a few weeks, and the oldest drop off daily. Pull every retained file early (`rsync -a` from the host's log folders, see the host runbook), work only on the local copy, and make it read-only. rsync exit 23 means some files were unreadable: the rest copied, so list the missing ones in the report.

Old file dates and rotation numbers say nothing about coverage, and neither does a file's first line: some logs open with a blank line, and each layer writes its date in its own format. Take the earliest and latest date over every line, in any of the four formats (access `[21/Oct/2026:00:58:14`, nginx error `2026/10/21 00:58:14`, FPM slow `[21-Oct-2026 00:58:14]`, Apache error `[Wed Oct 21 00:58:14.516683 2026]`):

```sh
for log in archive/logs-<stamp>/<site>/*; do
  gzip -dcf "$log" | LC_ALL=C awk -v file="$log" '
    BEGIN { split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", names, " "); for (i = 1; i <= 12; i++) month[names[i]] = sprintf("%02d", i) }
    match($0, /[0-9][0-9]\/[A-Z][a-z][a-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { s = substr($0, RSTART, RLENGTH); found(substr(s, 8, 4) "-" month[substr(s, 4, 3)] "-" substr(s, 1, 2) "T" substr(s, 13, 8)); next }
    match($0, /[0-9][0-9][0-9][0-9]\/[0-9][0-9]\/[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { s = substr($0, RSTART, RLENGTH); found(substr(s, 1, 4) "-" substr(s, 6, 2) "-" substr(s, 9, 2) "T" substr(s, 12, 8)); next }
    match($0, /[0-9][0-9]-[A-Z][a-z][a-z]-[0-9][0-9][0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { s = substr($0, RSTART, RLENGTH); found(substr(s, 8, 4) "-" month[substr(s, 4, 3)] "-" substr(s, 1, 2) "T" substr(s, 13, 8)); next }
    match($0, /[A-Z][a-z][a-z] [0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9][.0-9]* [0-9][0-9][0-9][0-9]\]/) { split(substr($0, RSTART, RLENGTH), part, " "); found(substr(part[4], 1, 4) "-" month[part[1]] "-" part[2] "T" substr(part[3], 1, 8)); next }
    function found(stamp) { lines++; if (first == "" || stamp < first) first = stamp; if (stamp > last) last = stamp }
    END { printf "%s\t%s\t%s\t%d dated lines\n", file, (lines ? first : "no date"), last, lines }'
done
```

Group the rows by log type. A busy log (access) rotates daily, so a rotation dated years before an otherwise continuous month is a stale leftover. Error and slow logs rotate only when written, so their old rotations are sparse real events and count toward that type's coverage.

State the continuous coverage window per log type, with stale rotations named as stale. When it misses the attack window, the site's own records date it ([incident-response.md](incident-response.md#dating-without-logs)).

## Beyond the docroot

The account usually holds more than the WordPress docroot: the app's config folder, home dotfiles (shell rc files run on every login), server config the SSH user can read (PHP, web server, cache, database), crontabs, the host's own backups on the server's disk, and other docroots or databases. Image what the user can read in one call, into the snapshot beside the site:

```sh
rsync -aR --exclude=<docroot> --exclude=<logs> <host>:<path> <host>:<path> … snapshots/<stamp>/account/
ssh <host> 'crontab -l' > snapshots/<stamp>/account/crontab.txt
ssh <host> 'cd <docroot> && wp db query "SHOW DATABASES" --skip-column-names --skip-plugins --skip-themes' > snapshots/<stamp>/account/databases.txt
```

The host runbook lists the paths. rsync exit 23 is expected for root-only files: list them in `account-manifest.md` under "not captured", beside a row per captured folder (files, size, what it is). A host backup archive found there becomes a verified second copy once `gzip -t` passes and a listing (`tar -tzf`) shows its docroot and dump. Key stores (`~/.ssh` private keys, `.gnupg`) stay out; `authorized_keys` comes in, since a planted key is evidence. The account copy holds secrets, so it stays out of mirrors.

Any code it holds outside WordPress gets read like the rest ([incident-response.md](incident-response.md)).

## Transfer rates

Large media and many small PHP files move at rates an order of magnitude apart, so estimate a long transfer from the job itself: read the `.partial` folder's size (`du -sk`) twice, 60 seconds apart, in its first minutes, and re-estimate after the first app.

## Archives

| Archive | Holds | Built | Use |
| --- | --- | --- | --- |
| as found | the first snapshot before any change (implant, keys and all), every retained log, uploads | `cp -cR` from the snapshot, then `chmod -R a-w`; first `find <snapshot> ! -perm -u+r`, since rsync keeps server modes and one file its owner can't read fails the clone (an `&&` chain then skips the hashing and `chmod`): `chmod u+r` each hit and note it in the manifest | evidence only; a replica is a clone of it |
| known good | the post-cleanup dump, `wp-config.php` and every file it requires, the active theme and its companion plugin, as plain files and tarballs with `SHA256SUMS` | after cleanup; restore-tested (above) | the restore point |

Verified dumps taken between containment and cleanup are evidence, not rebuild sources: they still hold the attacker's footholds (remote-management keys, implant options) and every stored credential. Label them "as found after containment, not known clean".

Check an archive with `find <archive> -type f -perm -u+w | head` (read-only: prints nothing), `find <archive> -type f -links +1 | head` (unlinked: prints nothing) and `shasum -a 256 -c SHA256SUMS`.

Moving a read-only folder to a new parent needs write permission on the folder itself, since its `..` entry is rewritten: `chmod u+w <top>`, `mv`, `chmod u-w <top>`, then compare inode and link counts with `stat` and rerun `shasum -c`.

## Mirrors

A git-tracked copy of live code, refreshed from each new snapshot, turns any change on the live site, planted or legitimate, into a `git diff`.

- Refresh with `rsync -a --delete --itemize-changes <snapshot>/site/ sites/<name>/mirror/`, then `git diff --stat`, from a snapshot that has a manifest, never from an as-found image.
- Track the whole docroot, core and large vendor plugins included: that's where planted files land.
- One list says what a mirror never holds (site-generated secrets, caches, uploads, logs, backup folders): the `sites/*/mirror/` lines of `.gitignore`. Pass the same paths to the refresh as rsync excludes, and refresh only once that list exists.
- rsync protects excluded paths from `--delete`, so when a refresh brings in a secret, add its path to that list and remove the file from the mirror by hand.
- Plugins ship their own `.gitignore` files and folders named `vendor/`, `packages/` or `Archive/`: exclude nested `.gitignore` files from the mirror, anchor root ignore patterns, and set `sites/*/mirror/** -text` in `.gitattributes` so CRLF files stay byte-exact.
