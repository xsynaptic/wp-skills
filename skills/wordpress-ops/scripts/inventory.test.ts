import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";

import type { Component } from "./inventory.ts";
import type { DirectoryRecord, Fetched } from "./lookups.ts";

import {
  comparableVersion,
  inventoryFlags,
  isVouchedFor,
  pluginSlug,
} from "./inventory.ts";
import { isAffected } from "./lookups.ts";

// wordpress.org records as the API returned them on 2026-10-22; fields no flag reads are left empty
const latestCore = "7.1.3";

function listed(fields: {
  headerAuthor?: string;
  lastUpdated: null | string;
  tested: null | string;
}): Fetched<DirectoryRecord> {
  return {
    isOk: true,
    value: {
      headerAuthor: fields.headerAuthor ?? null,
      lastUpdated: fields.lastUpdated,
      owner: "",
      requiresPhp: null,
      state: "listed",
      tested: fields.tested,
      version: "",
    },
  };
}

function component(
  fields: Partial<Component> &
    Pick<Component, "directory" | "kind" | "path" | "slug">,
): Component {
  return {
    author: "",
    isInUse: true,
    ownerChange: null,
    updateUri: "",
    version: "",
    vulnerabilities: {
      isOk: true,
      value: { isKnown: true, vulnerabilities: [] },
    },
    ...fields,
  };
}

const akismet = component({
  author: "Automattic - Anti-spam Team",
  directory: listed({ lastUpdated: "2026-08-18", tested: "7.1.3" }),
  kind: "plugin",
  path: "wp-content/plugins/akismet",
  slug: "akismet",
});
const popupAnything = component({
  directory: {
    isOk: true,
    value: {
      closedDate: "2026-04-07",
      reason: "Security Issue",
      state: "closed",
    },
  },
  kind: "plugin",
  path: "wp-content/plugins/popup-anything-on-click",
  slug: "popup-anything-on-click",
});
const liteSweepPremium = component({
  directory: { isOk: true, value: { state: "absent" } },
  kind: "plugin",
  path: "wp-content/plugins/lite-sweep-premium",
  slug: "lite-sweep-premium",
});
const phpCodeWidget = component({
  directory: listed({ lastUpdated: "2022-03-30", tested: "5.9.19" }),
  kind: "plugin",
  path: "wp-content/plugins/php-code-widget",
  slug: "php-code-widget",
});
const untestedPlugin = component({
  directory: listed({ lastUpdated: "2025-05-14", tested: "5.8.18" }),
  kind: "plugin",
  path: "wp-content/plugins/untested-plugin",
  slug: "untested-plugin",
});
const twentyTwentyFive = component({
  author: "the WordPress team",
  directory: listed({
    headerAuthor: "the WordPress team",
    lastUpdated: null,
    tested: null,
  }),
  kind: "theme",
  path: "wp-content/themes/twentytwentyfive",
  slug: "twentytwentyfive",
});
// The same slug whose installed header names another author: not the code wordpress.org serves
const twentyTwentyFiveOtherAuthor = {
  ...twentyTwentyFive,
  author: "Automattic",
};
const akismetReassigned = {
  ...akismet,
  ownerChange: "automattic at scan 20261021T143000Z, wpsalesdesk now",
};
const helloLookupFailed = component({
  author: "Matt Mullenweg",
  directory: {
    error: "wordpress.org plugin hello-dolly: HTTP 503",
    isOk: false,
  },
  kind: "plugin",
  path: "wp-content/plugins/hello.php",
  slug: "hello",
});

describe("pluginSlug", () => {
  test("the slug is the folder, whatever the main file is called", () => {
    assert.equal(pluginSlug("akismet/akismet.php"), "akismet");
    assert.equal(
      pluginSlug("sqlite-database-integration/load.php"),
      "sqlite-database-integration",
    );
  });

  test("a single-file plugin's slug is its file name", () => {
    assert.equal(pluginSlug("hello.php"), "hello");
  });

  test("a folder renamed for containment keeps its slug", () => {
    // incident-response.md quarantines a plugin by renaming its folder to `<slug>.disabled`
    assert.equal(
      pluginSlug("updraftplus.disabled/updraftplus.php"),
      "updraftplus",
    );
  });
});

describe("comparableVersion", () => {
  // An UpdraftPlus advisory as WPVulnerability publishes it, citing only Free's numbers
  const freeNumberedAdvisory = {
    max_operator: "lt",
    max_version: "1.26.5",
    min_operator: null,
    min_version: null,
    unfixed: "0",
  };

  test("UpdraftPlus Premium is matched against the Free release it tracks", () => {
    assert.equal(
      isAffected(
        comparableVersion("updraftplus", "2.26.4.0"),
        freeNumberedAdvisory,
      ),
      true,
    );
    assert.equal(
      isAffected(
        comparableVersion("updraftplus", "2.26.5.0"),
        freeNumberedAdvisory,
      ),
      false,
    );
  });

  test("UpdraftPlus Free and other plugins keep their own numbers", () => {
    assert.equal(
      isAffected(
        comparableVersion("updraftplus", "1.26.4"),
        freeNumberedAdvisory,
      ),
      true,
    );
    assert.equal(
      comparableVersion("popup-anything-on-click", "2.9.1"),
      "2.9.1",
    );
  });
});

describe("inventoryFlags", () => {
  before(() => {
    mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-10-22T00:00:00Z"),
    });
  });
  after(() => {
    mock.timers.reset();
  });

  test("a current plugin raises nothing", () => {
    assert.deepEqual(inventoryFlags(akismet, latestCore), []);
  });

  test("a plugin closed on wordpress.org is flagged with its date and reason", () => {
    assert.deepEqual(inventoryFlags(popupAnything, latestCore), [
      "**closed on wordpress.org** 2026-04-07 (Security Issue)",
    ]);
  });

  test("a plugin wordpress.org doesn't know is flagged", () => {
    assert.deepEqual(inventoryFlags(liteSweepPremium, latestCore), [
      "not on wordpress.org",
    ]);
  });

  test("a plugin without a release in over four years is flagged as four", () => {
    assert.deepEqual(inventoryFlags(phpCodeWidget, latestCore), [
      "no release in 4 years (last 2022-03-30)",
      "tested up to 5.9.19",
    ]);
  });

  test("a recent release untested on current core is flagged only as untested", () => {
    assert.deepEqual(inventoryFlags(untestedPlugin, latestCore), [
      "tested up to 5.8.18",
    ]);
  });

  test("a theme whose header matches wordpress.org raises no author flag", () => {
    assert.deepEqual(inventoryFlags(twentyTwentyFive, latestCore), []);
  });

  test("a theme whose header names another author is flagged", () => {
    assert.deepEqual(inventoryFlags(twentyTwentyFiveOtherAuthor, latestCore), [
      '**author differs: installed "Automattic", wordpress.org "the WordPress team"**',
    ]);
  });

  test("a plugin whose wordpress.org owner changed is flagged", () => {
    assert.deepEqual(inventoryFlags(akismetReassigned, latestCore), [
      "**wordpress.org owner changed: automattic at scan 20261021T143000Z, wpsalesdesk now**",
    ]);
  });

  test("a failed lookup is reported, not read as clean", () => {
    assert.deepEqual(inventoryFlags(helloLookupFailed, latestCore), [
      "single file",
      "wordpress.org lookup failed",
    ]);
  });
});

describe("isVouchedFor", () => {
  before(() => {
    mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-10-22T00:00:00Z"),
    });
  });
  after(() => {
    mock.timers.reset();
  });

  test("a maintained listed plugin whose files verify is vouched for", () => {
    assert.equal(isVouchedFor(akismet, true), true);
  });

  test("the same plugin with modified or unverifiable files is not", () => {
    assert.equal(isVouchedFor(akismet, false), false);
  });

  test("a listed plugin without a release in two years is not, though it verifies", () => {
    assert.equal(isVouchedFor(phpCodeWidget, true), false);
  });

  test("themes are not, having no checksums to verify against", () => {
    assert.equal(isVouchedFor(twentyTwentyFive, true), false);
  });

  test("closed, absent and unlooked-up plugins are not", () => {
    assert.equal(isVouchedFor(popupAnything, true), false);
    assert.equal(isVouchedFor(liteSweepPremium, true), false);
    assert.equal(isVouchedFor(helloLookupFailed, true), false);
  });

  test("a release from a new owner is not", () => {
    assert.equal(isVouchedFor(akismetReassigned, true), false);
  });
});
