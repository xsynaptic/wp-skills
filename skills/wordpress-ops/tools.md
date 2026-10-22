# Tools and data sources

Every external tool and data source the other files rely on, with its pin, install line, the commands that matter, and its traps. Verified 2026-10-21; a pin a month old may already have moved, so re-check anything load-bearing (a release page, an API probe) before relying on it. Where WordPress/agent-skills is installed, load its `wp-phpstan` and `wp-wpcli-and-ops` skills for generic setup rather than working it out here.

## Pins

| Tool | Pin | Where it runs |
| --- | --- | --- |
| WP-CLI | 2.12.0 (3.0 is alpha only) | server and local |
| checksum-command | v2.3.1, bundled with WP-CLI 2.12 | server and local |
| profile-command / doctor-command | v2.1.5 / v2.3.1 | local stack only |
| PHPCompatibilityWP + PHPCompatibility | 3.0.0-alpha2 + 10.0.0-alpha2 | workspace |
| PHPStan + szepeviktor/phpstan-wordpress + php-stubs/wordpress-stubs | 2.3.1 / v2.0.4 / v7.1.2 | workspace, on owned and claimed code |
| johnbillion/wp-compat + phpstan/phpstan-deprecation-rules | 3.0.0 / 2.0.5 | workspace, on owned and claimed code |
| Rector | 2.7.0 | workspace |
| Semgrep CE + CodeVigilant rules | 1.182.1 + git HEAD | workspace, on claimed and off-repo code |
| Plugin Check / Theme Check | 2.1.0 / 20260901 | local stack only |
| YARA | 4.5.8 | workspace, over a mirror or snapshot |
| php-malware-finder `php.yar` | archived 2023, rules still usable | with YARA |
| Neo23x0/signature-base webshell rules | git HEAD | with YARA |
| PHP-Antimalware-Scanner | v0.21.15 | workspace or server (pure PHP) |
| lnav / GoAccess | 0.14.1 / 1.12 | workspace, over pulled logs |
| WPProbe / nuclei + nuclei-templates | v0.12.12 / v3.11.1 + v10.5.0 | outside-in only |

## WP-CLI

- On 2.12, `wp package install <package>:@stable` resolves to the last 2.x line that accepts 2.12, because every command package's 3.0 needs a WP-CLI 3.0 that isn't released.
- 2.12 runs on PHP 5.6 and up; the next release requires 7.2.24, which matters on an old server's CLI.
- `wp profile` and `wp doctor` load plugins and the theme, so they break the `--skip-plugins --skip-themes` rule: run them on the rehearsal stack. Where `~/.wp-cli/packages` is broken, install into a scratch folder with `WP_CLI_PACKAGES_DIR=<scratch>`.
- `wp doctor check --all`; its `--config=<yaml>` takes custom checks, and file-contents regex checks make a cheap indicator scan.

## Integrity

```sh
wp core verify-checksums --include-root --version=<installed> --locale=<installed locale> --skip-plugins --skip-themes
wp plugin verify-checksums --all --format=json --skip-plugins --skip-themes
```

| Trap | Reading |
| --- | --- |
| `--locale` differs from the install | every localized file fails; pass the site's own |
| core checksums and the docroot | without `--include-root`, only core's directories and root files named `wp-*` are checked, so a planted root-level PHP file under any other name (and `.user.ini`) passes |
| `Success` with warnings | extra files are only `File should not exist` warnings: the command still prints `Success` and exits 0, so read every warning line |
| plugin checksums cover wordpress.org plugins only | premium plugins are skipped ("Could not retrieve the checksums"), and that's where the risk usually is |
| a wordpress.org plugin skipped | a large plugin's checksum file can outlast WP-CLI's 10-second timeout (`cURL error 28` just above the skip line), which reads like a premium skip; rerun that plugin by name |
| matched by folder slug | a premium or forked plugin in a folder named like a wordpress.org plugin is checked against the wrong code |
| closed plugins | still verify: their published checksums stay served, and SVN stays readable for a diff |
| mu-plugins | not verified by v2.3.1 |
| `hello.php` fails | it matches the copy bundled with core; harmless |
| missing or truncated core files reported on every run | an install archive cut them, and minor updates ship only changed files, so they never self-heal; repair them first, so later checks mean something ([upgrades.md](upgrades.md)) |
| themes | no checksums exist; diff against a pristine zip (`https://downloads.wordpress.org/theme/<slug>.<version>.zip`, or the vendor's download) |

## Static analysis

PHPCompatibility, in a throwaway Composer project in the workspace (only the alpha releases carry the PHP 8.4 and 8.5 sniffs; PHPCompatibilityWP's alpha accepts any PHPCompatibility 10 alpha, so pin both):

```sh
composer config minimum-stability alpha
composer config allow-plugins.dealerdirect/phpcodesniffer-composer-installer true
composer require --dev phpcompatibility/phpcompatibility-wp:3.0.0-alpha2 phpcompatibility/php-compatibility:10.0.0-alpha2
vendor/bin/phpcs -d memory_limit=1G -p -s --standard=PHPCompatibilityWP --runtime-set testVersion <current>-<target> --extensions=php,inc <path>
```

`testVersion 8.2-8.4` reports what breaks on any version from the current PHP to the target, since the code serves on the current one until the switch; `7.4-` reports anything broken on 7.4 or later. Big themes need the raised memory limit.

PHPStan for code you own:

```sh
composer require --dev phpstan/phpstan:2.3.1 szepeviktor/phpstan-wordpress:v2.0.4 php-stubs/wordpress-stubs:v7.1.2 \
  johnbillion/wp-compat:3.0.0 phpstan/phpstan-deprecation-rules:2.0.5
```

Include the WordPress extension's `extension.neon` (check the path under `vendor/szepeviktor/` after install) and each rule package's config per its README. A theme that calls a companion plugin's functions needs `scanDirectories` pointing at that plugin, or every call reports as undefined. `wp-compat` reads `Requires at least` from `style.css` or the main plugin file and flags functions missing from that core version.

Rector: pin `withPhpVersion` to the oldest PHP the code must still run on and apply only the rules for the breakage found. `withPhpSets` treats its version as a ceiling and rewrites syntax upward, which breaks the site on its current PHP. The PHP 8.4 implicitly-nullable fix produces `?Type $x = null`, valid from 7.1, so it is safe on a 7.4 floor.

Plugin Check, on the rehearsal stack:

```sh
wp plugin check <slug> --categories=security --format=json --require=./wp-content/plugins/plugin-check/cli.php
```

The output is a `FILE: <path>` line followed by one JSON array per file, not one document, so parse it line by line. The security checks worth reading on inherited code: `late_escaping`, `direct_db_queries`, `direct_file_access`, `safe_redirect`. It has no theme mode. Theme Check (`wp theme-check run <theme> --format=json`) checks the theme directory's rules, so most findings on a ThemeForest theme are guideline noise.

Semgrep, over claimed and off-repo code after the grep triage ([claiming-code.md](claiming-code.md#2-read-the-code)):

```sh
pipx install semgrep==1.182.1
git clone --depth 1 https://github.com/CodeVigilant/codevigilant_semgrep_rules
semgrep scan --metrics=off --config codevigilant_semgrep_rules/php/wordpress/ <component>
```

The free engine follows request input to a sink only inside one function, so input passed through a helper drops out and a clean run clears nothing. The rule set is small, with one maintainer; its `php/coding-standards/` rules are ported from WPCS and VIP and mostly repeat phpcs. `--config auto` refuses to run with metrics off.

## Malware scanning

One layer among several, in this order over a mirror or snapshot: checksums, the pristine-zip diff for premium code, then YARA, then a plain `find wp-content/uploads -name '*.php'` (uploads should hold no PHP at all, and the benign ones still need triage).

```sh
yara -r php-malware-finder/data/php.yar <docroot>/wp-content
yara -r signature-base/yara/gen_webshells.yar <docroot>/wp-content
php scanner <docroot> --lite --report-only
```

Some signature-base rules use external variables (`gen_webshells_ext_vars.yar`): pass `-d filename=<name>` or leave those files out. YARA Forge's weekly bundle is broad and noisy on vendor libraries. Whether `php.yar` compiles under YARA-X is unverified.

## Vulnerability and status data

| Source | Query | Use |
| --- | --- | --- |
| wordpress.org plugins API | `curl -sg 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&slug=<slug>'` | the authority on closure: `"error":"closed"` with `closed_date` and `reason`; `"Plugin not found."` for premium. Also `version`, `last_updated`, `tested`, `requires_php`, `author`. Themes: `themes/info/1.2/?action=theme_information&slug=<slug>` |
| WPVulnerability | `https://www.wpvulnerability.net/plugin/<slug>/`, `/theme/<slug>/`, `/core/<version>/`, `/php/<version>/` | keyless; every known vulnerability for the slug with its affected range, `unfixed` and CVE ids; filter by the installed version yourself. Its "closed" flag has given false positives, and it has missed a KEV-listed core CVE entirely, so it never stands alone for core |
| GitHub core advisories | `gh api --paginate repos/WordPress/wordpress-develop/security-advisories` | the authority for core: ranges per branch. Every branch from 4.7 gets security backports, so on old core the fix is usually the branch's latest point release, not a major upgrade |
| CISA KEV | the JSON feed, below | whether a CVE found above is exploited in the wild; check every one |
| core version APIs | `https://api.wordpress.org/core/stable-check/1.0/`, `https://api.wordpress.org/core/version-check/1.7/` | "latest", "outdated" or "insecure" per version; the minimum PHP per release |
| Wordfence Intelligence v3 | the whole feed with a Bearer key from a free Wordfence account (the owner's), about one request per 30 minutes | optional cross-check; no per-slug query. Show MITRE's copyright notice with any MITRE record shown to someone |

```sh
curl -s https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json |
  jq '.vulnerabilities[] | select(.cveID == "<id>")'
```

## Outside-in

Only against sites the operator is authorized to assess, before shell access arrives or on hosts without it. WPProbe (`wpprobe update-db`, then `wpprobe scan`; flags from `--help`) enumerates plugins through REST and HTML without brute force. nuclei with `-tags wordpress` runs the official templates; the community `nuclei-wordfence-cve` templates are version fingerprints, not exploit checks, so a hit means "this version is listed", nothing more.

## Not used

| Tool | Why |
| --- | --- |
| Wordfence CLI | its free tier ended 2026-10-14, and `vuln-scan` needs a licence too |
| WPScan API | free tier is non-commercial only, 25 calls a day |
| Patchstack API | paid, activated on request |
| `typisttech/wordfence-api` | archived, built against the removed v2 feed |
| Pressidium YARA rules | stale since 2023 |
| secator | Business Source License, built for fleets |
| ClamAV, Linux Malware Detect | ClamAV is weak on PHP webshells alone; LMD needs root, so on a managed host it only runs against a local mirror |
| MCP servers holding admin credentials | attack surface. Core's Abilities API (in core since 6.9, a `public` flag since 7.1) with `WordPress/mcp-adapter` is where read-only agent access is heading; not used yet |
