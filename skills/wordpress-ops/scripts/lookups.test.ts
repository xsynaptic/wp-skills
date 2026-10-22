import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareVersions, inAdvisoryRange, isAffected } from "./lookups.ts";

type Operator = Parameters<typeof isAffected>[1];

// Operator records in the shape WPVulnerability publishes
const ltBound = {
  max_operator: "lt",
  max_version: "1.26.5",
  min_operator: null,
  min_version: null,
  unfixed: "0",
} satisfies Operator;
const leBound = {
  max_operator: "le",
  max_version: "1.13.12",
  min_operator: null,
  min_version: null,
  unfixed: "0",
} satisfies Operator;
const geAndLtBound = {
  max_operator: "lt",
  max_version: "1.26.8",
  min_operator: "ge",
  min_version: "1.23.8",
  unfixed: "0",
} satisfies Operator;
const fourPartFix = {
  max_operator: "lt",
  max_version: "2.9.1.1",
  min_operator: null,
  min_version: null,
  unfixed: "0",
} satisfies Operator;
const betaFix = {
  max_operator: "lt",
  max_version: "11.1.0",
  min_operator: null,
  min_version: null,
  unfixed: "0",
} satisfies Operator;

describe("compareVersions", () => {
  test("compares each part as a number", () => {
    assert.equal(compareVersions("1.16.69", "1.9.64"), 1);
    assert.equal(compareVersions("11.1.0", "9.8.0"), 1);
  });

  test("reads WordPress's x.y as the x.y.0 that advisories name", () => {
    assert.equal(compareVersions("7.1", "7.1.0"), 0);
  });

  test("orders a fourth part after the three-part release", () => {
    assert.equal(compareVersions("2.9.1", "2.9.1.1"), -1);
    assert.equal(compareVersions("4.2.0.1", "4.2.0"), 1);
  });

  test("orders a pre-release before its release", () => {
    // `$wp_version` in the 6.4 beta and RC tarballs; WordPress orders versions with PHP's version_compare, which agrees
    assert.equal(compareVersions("6.4-beta1", "6.4"), -1);
    assert.equal(compareVersions("6.4-RC1", "6.4"), -1);
    // WooCommerce's tag and header form
    assert.equal(compareVersions("11.1.0-beta.1", "11.1.0"), -1);
  });
});

describe("isAffected", () => {
  test("an `lt` bound excludes the fixed release", () => {
    assert.equal(isAffected("1.26.4", ltBound), true);
    assert.equal(isAffected("1.26.5", ltBound), false);
  });

  test("an `le` bound includes the last affected release", () => {
    assert.equal(isAffected("1.13.12", leBound), true);
    assert.equal(isAffected("1.13.13", leBound), false);
  });

  test("a `ge` bound excludes releases before the flaw was introduced", () => {
    assert.equal(isAffected("1.23.7", geAndLtBound), false);
    assert.equal(isAffected("1.23.8", geAndLtBound), true);
    assert.equal(isAffected("1.26.7", geAndLtBound), true);
    assert.equal(isAffected("1.26.8", geAndLtBound), false);
  });

  test("a four-part fix release leaves its three-part predecessor affected", () => {
    assert.equal(isAffected("2.9.1", fourPartFix), true);
    assert.equal(isAffected("2.9.1.1", fourPartFix), false);
  });

  test("a beta of the fix release is still affected", () => {
    assert.equal(isAffected("11.1.0-beta.1", betaFix), true);
  });
});

describe("inAdvisoryRange", () => {
  // Ranges as WordPress/wordpress-develop's GitHub advisories publish them
  test("a hyphen range includes both ends", () => {
    assert.equal(inAdvisoryRange("7.1.0", "7.1.0 - 7.1.1"), true);
    assert.equal(inAdvisoryRange("7.1.1", "7.1.0 - 7.1.1"), true);
    assert.equal(inAdvisoryRange("7.1.2", "7.1.0 - 7.1.1"), false);
  });

  test("a site on x.y matches a range starting at x.y.0", () => {
    // `$wp_version` is "7.1" for the 7.1.0 release
    assert.equal(inAdvisoryRange("7.1", "7.1.0 - 7.1.1"), true);
    assert.equal(inAdvisoryRange("7.1", "7.1.0 - 7.1"), true);
    assert.equal(inAdvisoryRange("7.1.1", "7.1.0 - 7.1"), false);
    assert.equal(inAdvisoryRange("7.1", "7.1.0"), true);
    assert.equal(inAdvisoryRange("7.1.1", "7.1.0"), false);
  });

  test("another branch's range does not match", () => {
    assert.equal(inAdvisoryRange("7.1.1", "6.9.0 - 6.9.8"), false);
    assert.equal(inAdvisoryRange("6.9.9", "6.9.0 - 6.9.8"), false);
  });

  test("tolerates the padding some advisories carry", () => {
    assert.equal(inAdvisoryRange("7.0.4", " 7.0.0 - 7.0.4 "), true);
    assert.equal(inAdvisoryRange("7.0.5", " 7.0.0 - 7.0.4 "), false);
  });

  test("a range spanning branches covers the old site inside it", () => {
    assert.equal(inAdvisoryRange("5.3.3", "3.7 - 5.4.1"), true);
    assert.equal(inAdvisoryRange("5.4.2", "3.7 - 5.4.1"), false);
  });

  test("comparator ranges apply every bound", () => {
    // One range per branch
    assert.equal(inAdvisoryRange("6.4.2", ">= 6.4.0 <6.4.3"), true);
    assert.equal(inAdvisoryRange("6.4.3", ">= 6.4.0 <6.4.3"), false);
    assert.equal(inAdvisoryRange("6.3.2", ">= 6.4.0 <6.4.3"), false);
    assert.equal(inAdvisoryRange("4.1.5", "<4.1.40"), true);
    assert.equal(inAdvisoryRange("4.1.40", "<4.1.40"), false);
    assert.equal(inAdvisoryRange("4.2.0", "<4.1.40"), false);
    assert.equal(inAdvisoryRange("5.8.2", "< 5.8.3"), true);
    assert.equal(inAdvisoryRange("5.8.3", "< 5.8.3"), false);
  });

  test("a list matches the versions it names", () => {
    assert.equal(
      inAdvisoryRange("5.3.0", "5.0.7, 5.1.3, 5.2.4, and 5.3.0"),
      true,
    );
    assert.equal(
      inAdvisoryRange("5.2.4", "5.0.7, 5.1.3, 5.2.4, and 5.3.0"),
      true,
    );
    assert.equal(
      inAdvisoryRange("5.3.1", "5.0.7, 5.1.3, 5.2.4, and 5.3.0"),
      false,
    );
    const branches = "4.7.15, 4.8.11, 4.9.12, 5.0.7, 5.1.3, 5.2.4, 5.3.0";
    assert.equal(inAdvisoryRange("4.9.12", branches), true);
    assert.equal(inAdvisoryRange("4.9.13", branches), false);
  });

  test("a pre-release range is unparseable, not a miss", () => {
    assert.equal(inAdvisoryRange("5.8", "5.8 beta 1 - 5.8 beta 2"), null);
    assert.equal(inAdvisoryRange("5.8", "5.8 beta 1"), null);
  });
});
