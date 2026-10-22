# Indicator packs

One JSON file per campaign: what a defender searches for (file strings, slug and option patterns, user names, request shapes) and nothing else. `scripts/scan.ts` loads every `*.json` in this folder. A pack is data, so it holds no code, no IP address, no site or domain of a victim, and no per-site value (a trigger token, a key name, an implant's password): those belong to one incident record, not to every scan. The technique classes these indicators belong to are in [incident-response.md](../../incident-response.md).

## Format

```ts
interface IndicatorPack {
  id: string;
  title: string;
  technique: string;
  verified: string;
  sources: string[];
  indicators: Indicator[];
}

type Indicator = FileString | NamePattern | Request;

interface Common {
  role: "implant" | "attack" | "entry" | "evidence";
  strength: "strong" | "weak";
  note: string;
}

interface FileString extends Common {
  kind: "file-string";
  match: "literal" | "regex";
  value: string;
  roots: ("plugins" | "mu-plugins" | "themes" | "uploads" | "root")[];
}

interface NamePattern extends Common {
  kind:
    "plugin-slug" | "option-name" | "cron-hook" | "user-login" | "user-email";
  value: string;
}

interface Request extends Common {
  kind: "request";
  label: string;
  method: string;
  path: string;
  userAgent: string;
  requestBytes?: [number, number];
  responseBytes?: [number, number];
}
```

| Field | Meaning |
| --- | --- |
| `id` | kebab-case, equal to the file name without `.json` |
| `technique` | the indicator class in `incident-response.md` this campaign is an instance of |
| `verified` | the date the indicators were last checked against `sources` or an incident record |
| `role` | `implant`: left on the site by the attacker. `attack`: the attacker's traffic in logs. `entry`: the foothold the campaign uses, present on sites never attacked, so an exposure to close. `evidence`: a record to preserve before cleanup deletes it |
| `strength` | `strong`: a hit alone goes in the scan's headline. `weak`: reported only when the same object also has a strong hit or one of the scan's own signals (not on wordpress.org, headerless or empty main file, active but missing, mtime inside the incident window) |
| `roots` | where `file-string` searches, under `wp-content/` except `root` (PHP files at the docroot's top level) |
| `plugin-slug` value | a JavaScript regular expression source, anchored explicitly, matched against plugin folder names |
| `option-name`, `cron-hook`, `user-login`, `user-email` value | an SQL `LIKE` pattern with `\_` and `\%` for literals; the scanner applies it to every table prefix in the database, since a dormant second install is a place to hide |
| `request` | `method` and `path` exact, `userAgent` a regular expression source; `requestBytes` is the body size PHP-FPM logged and `responseBytes` the reply size the proxy logged, each an inclusive range, used to label hits by the `label` that matches |
| `note` | what a hit means, and the legitimate thing that can look like it |

## Adding a pack

1. Start from a published analysis or the operator's own incident record. Strip addresses, victim names and per-site values; keep what recurs across sites.
2. Mark an indicator `strong` only when no legitimate install plausibly carries it, and say in `note` what does look like it.
3. Scan a snapshot known to be clean (a site the campaign never reached). Any `strong` hit there is `weak`.
4. Scan the incident's as-found snapshot, or a seeded replica, and confirm the pack headlines what the record says was there.

Done when the clean scan headlines nothing from the pack and the as-found scan headlines every implant the record names.
