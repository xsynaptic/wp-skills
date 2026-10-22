# Log analysis

What a server's logs can and can't show about an incident and the routine abuse around it. Work on the local pull ([evidence.md](evidence.md#log-pulls)), never on the server. The host runbook names the files and their formats; this file says what each layer means and how to read it. Every claim in a log review carries a count and the file it came from, and the review opens with the coverage window it rests on.

## Layers

Each layer saw a different subset of the traffic, so place every file in the pull before reading it:

| Layer | Shows | Leaves out |
| --- | --- | --- |
| CDN edge | everything, but it isn't on the server |  |
| proxy, passed on | every request it forwarded, with status and reply size | what ran |
| proxy, answered itself | static files, blocks, bot challenges | anything WordPress did |
| backend access | requests that reached WordPress | requests the proxy stopped |
| PHP-FPM access | the script PHP actually ran, the request body size, the request URI | the body itself |
| error logs | PHP fatals and warnings; proxy refusals, often the only line carrying the Host header | successes |
| slow log | slow scripts and pool restarts |  |

## Reading traps

- **The challenge page.** Where the host's bot protection answers scanners with a fixed-size challenge, it is logged as `200`. Its size is the commonest reply size among `200`s the proxy answered alone for paths that don't exist; a "200" for a secret or backup path at that size is the challenge, not a leak.
- **Your own traffic:** cache-busting parameters (`?smoke=`, `?nocache=`), `curl` and `node` user agents, temporary-admin sessions, the server calling itself (a plugin's loopback test). List what you excluded and why.
- **Shared and edge addresses.** Behind a CDN that doesn't restore the client address, every line logs an edge address, and a site's history can straddle that change. Consumer VPN ranges are shared: an address in the attacker's /48 that reads articles is a reader. Check every attributed address against the CDN's published ranges and against what it requested.
- **Stale rotations** get the incident's indicators only, not the routine sweeps.

## Indicators and outcomes

Sweep the incident's indicators across every app and every date: the pack's user agents and request shapes, implant names, trigger parameters, the incident's addresses and their prefix, and the paths of every exposure found. Every app on the server, since one stolen key list or one scanner reaches them all, and the catch-all app collects requests for hostnames nobody claims.

Tell outcomes apart by size: compare each hit's reply size with the same path's ordinary response, and FPM body sizes across hits. A key test sends a tiny body and gets a tiny reply; a command sends kilobytes and gets a reply far smaller than the front page; a request that reached nothing gets the full ordinary page. Label every attack hit probe, command or ordinary page.

## Routine sweeps

Each counted by status, zero included:

| Sweep | How to read it |
| --- | --- |
| `POST /wp-login.php` | `302` success, `200` the form back (a failure), `403` blocked, `503` rate-limited; distinct addresses and the peak day; every `302` attributed to a known person |
| XML-RPC | requests, and whether FPM ever ran `xmlrpc.php`; a count near zero means something upstream refuses it, so the attempt volume is unknown |
| REST batch probes | small-body POSTs answered `207`, at `/wp-json/batch/v1` and at the query-string form `/?rest_route=/batch/v1`, percent-encoded slashes included; the editor's own batch saves come from logged-in sessions |
| PHP outside normal routes | FPM's list of scripts it ran, against core, the installed plugins and the theme: anything else ran code |
| secret and backup probes | `.env`, `.git`, copies of `wp-config.php`, archives, backup folders: any `200` other than the challenge |
| oversized bodies | body-size probes against `/` |
| admin sessions | successful logins and what followed: `user-edit.php`, `update-core.php`, plugin and theme installs, the file editors, REST writes to `users`, `plugins` and `settings` |
| encoded paths | `%2e`-encoded admin paths that slipped past the proxy's rules |
| install-takeover watchers | repeated `wp-admin/install.php?step=1` polls, waiting for a database outage that makes the installer appear |

The noise table: the top sources with request count, pattern and a block decision with its reason. One address scraping with thousands of user agents is a block; a scanner range hitting every app is a block; a distributed bot drawing challenges on one path is harmless; feed pollers are traffic. Add the PHP errors since the last platform change, each attributed to a file.

## What logs can't show

- **POST bodies.** A key or an action name sent in the body never reaches an access log, so the use of an unauthenticated AJAX hole can't be ruled out. Close it and say the history is unknowable.
- **Read-only abuse.** An action that lists users with their hashes, or relays mail, writes nothing to the database or the disk. Sort the POSTs to the endpoint by reply size and look for replies shaped like the action's output.
- **Cached responses** never reach PHP, and a CDN's cache never reaches the server at all.

So the strongest verdict a log review gives is **no sign of misuse**, with its counts ([incident-response.md](incident-response.md#verdicts-and-the-record)).

## Re-check before relaying

An alarming claim from a reviewing agent is checked against the dumps and live responses before it reaches the operator. Claims that turned out wrong:

| Claim | What it was | Check |
| --- | --- | --- |
| a backup folder is still public | quarantined earlier; it answers `404` | HEAD it now |
| a suspicious deleted account | the owner removing an old guest | the user row in an older dump, and the admin session that deleted it |
| a host bypass: requests for made-up hostnames | wildcard DNS through the CDN, landing on the catch-all app | the Host header in the proxy's error log; the DNS records |
| a `200` for a backup path | the challenge page | its reply size |
| an address in the attacker's range | a shared VPN prefix used by readers | the paths it requested |
| uploads when "nobody is uploading" | editors working through a VPN | match the files to attachment posts and authors, confirm they are real images, read the login records for those accounts |

## Commands

Over the combined format, `$1` is the address, `$6` and `$7` the method and path, `$9` the status and `$10` the reply size; the user agent is the sixth `"`-separated field. Substitute the host's file names for `<backend access>`.

```sh
logs=archive/logs-<stamp>/<site>
gzip -dcf "$logs"/<backend access>* | LC_ALL=C awk '$6 == "\"POST" && $7 ~ /^\/wp-login\.php/ {print $9}' | sort | uniq -c
gzip -dcf "$logs"/<backend access>* | LC_ALL=C awk -F'"' '$6 ~ /<pack user agent regex>/'
gzip -dcf "$logs"/<backend access>* | LC_ALL=C awk '$6 == "\"POST" && $7 == "/" {print $10}' | sort -n | uniq -c
gzip -dcf "$logs"/<backend access>* | LC_ALL=C awk '{print $1}' | sort | uniq -c | sort -rn | head -n 20
gzip -dcf "$logs"/<backend access>* | LC_ALL=C awk -F'"' '{split($1, head, " "); print head[1] "\t" $6}' | sort -u | cut -f1 | uniq -c | sort -rn | head -n 20
```

The last line counts distinct user agents per address, which is how one scraper rotating through thousands of them stands out.

- `zgrep` and `awk` over the raw files are the baseline for every count in the report.
- `lnav <folder>` merges rotations and layers into one time-ordered view: use it to read around a moment the counts pointed to.
- GoAccess is for traffic shape only (`gzip -dcf <files> | goaccess --log-format=COMBINED -o report.html -`): it aggregates, so it can't give a timeline.
