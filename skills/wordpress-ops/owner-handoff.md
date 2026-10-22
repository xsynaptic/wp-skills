# Owner handoff

Handing the owner what is theirs to do, recording what they decided, and listing the access that comes out. Write at the owner's level, as the workspace `CLAUDE.md` records it; the template and the style below assume someone who runs their site but isn't technical. The operator reviews the message and sends it.

## The message

Draft it from [templates/owner-message.md](templates/owner-message.md) into `docs/owner-message-<date>.md` (or an HTML page, if the operator sends a link), and keep its style through every revision:

- **Plain, never talking down.** Say what a thing does for them, not what it is: "security keys" rather than salts, "a scrambled copy of every password" rather than hashes.
- **Numbered straight through** across the groups, so the owner can answer "done 1 to 4".
- **Every item is something they can do:** the exact menu path, which site and which account, and how they know it worked. Menu wording drifts between plugin versions; say so where it might.
- **Passwords first, and theirs to change.** Resetting an owner's password for them locks them out before they have read the message.
- **Name no person as a cause.** Describe what happened, never who might have done it.

Each answer that comes back becomes a task in the plan (a server step with its snapshot, or a panel action for the operator) or a line in the decisions block.

## Rotation list

Built from the credential inventory ([incident-response.md](incident-response.md)) plus every value that printed in a transcript ([engagement.md](engagement.md)), grouped by the account the owner holds, the widest reach first. For each: what the site stored, what to do at the vendor, and whether it is optional.

| Account | Stored on the site | Owner's action |
| --- | --- | --- |
| WordPress logins | every password hash | each person changes their own password, on every site, all different |
| backup storage (cloud drive, object storage) | the backup plugin's OAuth token or app key | revoke the app's access (the account's third-party connections page) or delete the key; the backups there are full copies of the site |
| Jetpack / WordPress.com | connection tokens | disconnect and reconnect, which issues new tokens; stats come back after |
| theme marketplace | a personal API token (Envato Market and similar) | delete the tokens; remove the plugin if nothing else uses it |
| mail and newsletter services | API keys, SMTP passwords | create a new key, paste it into the plugin, delete the old one |
| analytics | OAuth connection | disconnect and reconnect |
| webhooks (chat, automation) | a webhook URL, which is itself the secret | delete it at the service if the site no longer sends there |
| CDN and DNS | API tokens in a cache or security plugin | revoke and reissue with the narrowest scope |
| licences | licence keys | optional, low value: reissue through the vendor or the host's support |

Not on it: API keys a theme or framework ships in its own code (a vendor's Google key that refetches a font list on admin load). Check whether a theme option overrides the shipped key; where none does, it is the vendor's default, not the owner's secret, and its fingerprint goes in the secret scanner's ignore file. Third-party keys defined as `wp-config.php` constants map to the rows above. Salts and the database password are rotated on the server, never by the owner: salts per [hardening.md](hardening.md), the password set on the database server (the panel, on a managed host) and in `wp-config.php` in one step.

Every inventory entry and every leaked value maps to a row.

## Decisions the owner holds

Put each in the message with its context and your lean; the operator acts on the answer.

- **Backups:** retention (lean: 14 days or more), whether to keep local copies on the server's disk (they cost space and restores still work from the off-site copy), one test restore onto a copy of the site, and whether to hold a second copy outside the host
- **Removing unused code:** the ranked list from [hardening.md](hardening.md), dangerous-if-reactivated first
- **Two-factor login:** offered; the date any grace period runs out
- **Who has access:** each administrator and editor named, with the question of whether they are still needed
- **DNS records:** a wildcard record that sends every made-up subdomain to the server, records for services nobody uses
- **Personal data the site no longer needs:** old orders with customer addresses, user exports, form entries
- **Updates:** who runs them and how often, and keeping remote-management plugins off the site

## Items the operator performs in the panel

Write each as a step for the operator, after the owner answers: backup schedule, retention and local copies; a test restore to a clone; cache purges the owner can't reach; removing the temporary SSH key. Host-specific paths are in the host runbook; on a self-managed server these are `vps-devops`'s.

## Temporary access

List everything the engagement added, and how each comes out:

- temporary SSH keys (the operator removes them in the panel or `authorized_keys`)
- temporary administrators: `scripts/live-check.ts` leaves none, so confirm with `wp user list --role=administrator`
- application passwords or API keys made for the work
- quarantine folders on the server, deleted by the operator or the owner once the incident is closed
- local snapshots and dumps holding every stored credential: delete once the incident is closed and the owner holds a clean off-site backup

## Decisions recorded as choices

Append to the workspace `CLAUDE.md` section of that name, one line per standing decision, so no later session proposes it again:

```markdown
- <Choice> (<who>, <date>): <reason>; comes back if <trigger>
```

The kinds that recur: `DISALLOW_FILE_MODS` declined because the owner updates in wp-admin (comes back if they hand maintenance over); no standing monitoring from the workspace; two-factor login offered, not required; off-site copies are the owner's; a one-way database-server upgrade shelved as unforced; an unmaintained plugin kept until a replacement is rehearsed.
