import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseUpdates, summarizeCoreChecksums } from "./wp-cli-output.ts";

// Captured from WP-CLI 2.12 (checksum-command 2.3.1) on PHP 8.5, against wordpress.org's real tarballs

const phpDeprecation =
  "Deprecated: Case statements followed by a semicolon (;) are deprecated, use a colon (:) instead in phar:///opt/homebrew/Cellar/wp-cli/2.12.0/bin/wp/vendor/react/promise/src/functions.php on line 369";

describe("summarizeCoreChecksums", () => {
  test("counts files left behind by a downgrade although WP-CLI says Success", () => {
    // 5.7 overlaid with 5.3.3, as a downgrade plugin leaves it, plus a host's `wp-salt.php`; the first six warnings
    const output = [
      "Warning: File should not exist: wp-salt.php",
      "Warning: File should not exist: wp-admin/authorize-application.php",
      "Warning: File should not exist: wp-admin/css/colors/modern/colors.scss",
      "Warning: File should not exist: wp-admin/css/colors/modern/colors.min.css",
      "Warning: File should not exist: wp-admin/css/colors/modern/colors-rtl.css",
      "Warning: File should not exist: wp-admin/css/colors/modern/colors.css",
      "Success: WordPress installation verifies against checksums.",
    ].join("\n");
    assert.deepEqual(summarizeCoreChecksums(output), {
      flags: ["6 files core doesn't ship"],
      isUnavailable: false,
    });
  });

  test("puts modified core files in the headline and counts missing ones apart", () => {
    // Two minified scripts truncated to zero bytes, an include appended to `load.php`, three long paths never extracted
    const output = [
      "Warning: File doesn't verify against checksum: wp-includes/js/dist/redux-routine.min.js",
      "Warning: File doesn't verify against checksum: wp-includes/js/dist/notices.min.js",
      "Warning: File doesn't verify against checksum: wp-includes/load.php",
      "Warning: File doesn't exist: wp-includes/php-ai-client/third-party/Http/Discovery/Exception/DiscoveryFailedException.php",
      "Warning: File doesn't exist: wp-includes/php-ai-client/third-party/Http/Discovery/Exception/NoCandidateFoundException.php",
      "Warning: File doesn't exist: wp-includes/php-ai-client/third-party/Http/Discovery/Exception/PuliUnavailableException.php",
      "Error: WordPress installation doesn't verify against checksums.",
    ].join("\n");
    assert.deepEqual(summarizeCoreChecksums(output), {
      flags: ["**3 modified core files**", "3 core files missing"],
      isUnavailable: false,
    });
  });

  test("reads a clean run through PHP's deprecation noise", () => {
    const output = [
      "PHP Deprecated:  Case statements followed by a semicolon (;) are deprecated, use a colon (:) instead in phar:///opt/homebrew/Cellar/wp-cli/2.12.0/bin/wp/vendor/react/promise/src/functions.php on line 369",
      "",
      phpDeprecation,
      "",
      "Success: WordPress installation verifies against checksums.",
    ].join("\n");
    assert.deepEqual(summarizeCoreChecksums(output), {
      flags: [],
      isUnavailable: false,
    });
  });

  test("a run that verified nothing is unavailable, not clean", () => {
    for (const output of [
      "Error: Couldn't get checksums from WordPress.org.",
      "Error: This does not seem to be a WordPress install.\nPass --path=`path/to/wordpress` or run `wp core download`.",
    ]) {
      assert.deepEqual(summarizeCoreChecksums(output), {
        flags: [],
        isUnavailable: true,
      });
    }
  });
});

describe("parseUpdates", () => {
  test("reads the plugin and theme lists past PHP's notices and the separating blank line", () => {
    // The scan's `wp plugin list …; echo; wp theme list …` with stderr dropped; PHP still prints notices to stdout
    const output = [
      "",
      phpDeprecation,
      '[{"name":"akismet","update_version":"5.7.2"},{"name":"hello","update_version":""},{"name":"sqlite-database-integration","update_version":""},{"name":"db.php","update_version":""}]',
      "",
      "",
      phpDeprecation,
      '[{"name":"twentytwentyfive","update_version":""},{"name":"twentytwentyfour","update_version":"1.6"},{"name":"twentytwentythree","update_version":""}]',
      "",
    ].join("\n");
    assert.deepEqual(
      parseUpdates(output),
      new Map([
        ["akismet", "5.7.2"],
        ["twentytwentyfour", "1.6"],
      ]),
    );
  });
});
