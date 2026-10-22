import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PackHit } from "./indicators.ts";

import {
  corroborate,
  loadIndicators,
  nameStem,
  normalizeObject,
} from "./indicators.ts";

const indicators = await loadIndicators();
const byKey = new Map(indicators.map((entry) => [entry.key, entry]));

function hit(value: string, object: string, subject: string): PackHit {
  const entry = indicators.find(
    ({ indicator, pack }) =>
      pack === "updraftcentral-2026" &&
      "value" in indicator &&
      indicator.value === value,
  );
  assert.ok(entry, `no indicator ${value}`);
  return { key: entry.key, object, subject };
}

const slugPattern = "^[a-z]+(-[a-z]+){1,2}(-[0-9a-f]{1,3})?$";
const listedSlugHit = hit(
  slugPattern,
  "contact-form-7",
  "plugin contact-form-7",
);
const implantSlugHit = hit(slugPattern, "lite-sweep-2", "plugin lite-sweep-2");
const implantFileHit = hit(
  "Small maintenance toolkit",
  "lite-sweep-2",
  '`wp-content/plugins/lite-sweep-2/lite-sweep-2.php` holds "Small maintenance toolkit"',
);
const implantOptionHit = hit(
  String.raw`%\_installed`,
  nameStem("lite_sweep_2_installed", String.raw`%\_installed`),
  "option-name lite_sweep_2_installed (wp_options)",
);
const implantLoginHit = hit(
  "content.desk%",
  normalizeObject("content.desk7"),
  "user-login content.desk7 (wp_users)",
);

describe("normalizeObject", () => {
  test("a plugin slug and the option prefix it writes name one object", () => {
    assert.equal(
      normalizeObject("lite_sweep_2"),
      normalizeObject("lite-sweep-2"),
    );
  });
});

describe("nameStem", () => {
  test("a suffix pattern leaves the plugin slug the option was written by", () => {
    assert.equal(
      nameStem("lite_sweep_2_installed", String.raw`%\_installed`),
      "lite-sweep-2",
    );
    assert.equal(
      nameStem("lite_sweep_2_sync_token", String.raw`%\_sync\_token`),
      "lite-sweep-2",
    );
  });

  test("a prefix pattern keeps the whole name", () => {
    assert.equal(
      nameStem(
        "_transient_udrpch_5f0c2a9e1b7d",
        String.raw`\_transient\_udrpch\_%`,
      ),
      "transient-udrpch-5f0c2a9e1b7d",
    );
  });
});

describe("corroborate", () => {
  test("a weak hit alone is counted, not reported", () => {
    assert.deepEqual(corroborate([listedSlugHit], byKey, new Set()), {
      reported: [],
      uncorroborated: 1,
    });
  });

  test("a strong hit corroborates weak hits on its own object only", () => {
    const hits = [
      implantSlugHit,
      listedSlugHit,
      implantFileHit,
      implantOptionHit,
      implantLoginHit,
    ];
    assert.deepEqual(corroborate(hits, byKey, new Set()), {
      reported: [
        implantSlugHit,
        implantFileHit,
        implantOptionHit,
        implantLoginHit,
      ],
      uncorroborated: 1,
    });
  });

  test("the scan's own signal corroborates a weak hit once the implant's folder is gone", () => {
    // The quarantined implant is still in `active_plugins` but missing from disk; its option remains
    assert.deepEqual(
      corroborate([implantOptionHit], byKey, new Set(["lite-sweep-2"])),
      { reported: [implantOptionHit], uncorroborated: 0 },
    );
  });
});
