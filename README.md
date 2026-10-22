# WordPress skills

A [Claude Code](https://claude.com/claude-code) skill for working on live WordPress sites, especially the kind you inherit: out of date, half forgotten, and maybe quietly compromised.

`wordpress-ops` covers looking a site over, reading its server logs, cleaning up after a compromise, upgrading PHP, core, themes and plugins, hardening, and taking over plugins and themes nobody maintains anymore. Most of it is principles and traps, the stuff that bites you when you don't know to look for it. The rest is a handful of scripts for the parts that are hard to get right by hand: snapshots, scans, smoke tests, and a local copy to rehearse changes on.

The scripts expect Node 24 on your machine, SSH, WP-CLI and rsync on the server, and Docker for the local copy. If your setup is different, the docs describe each check well enough to do it by hand. There's a host runbook for Cloudways; anywhere else, you fill in the paths yourself.

## Install

```sh
npx skills add xsynaptic/wp-skills
```

Or copy `skills/wordpress-ops` into `~/.claude/skills/`.

## Development

Run `pnpm install` and `composer install`, then `pnpm check` runs everything: formatting, types, lint, tests, and the PHP checks. The PHP helpers run on whatever PHP the server has, which can be a lot older than yours, so they're checked for compatibility back to 7.2.

## Licence

[MIT](LICENSE)
