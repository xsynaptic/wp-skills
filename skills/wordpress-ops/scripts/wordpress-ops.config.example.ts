// Copy to the workspace root as wordpress-ops.config.ts and point this import at the skill's scripts/config.ts
// Node erases type imports, so only the type checker reads that path
import type { Config } from "./config.ts";

export default {
  servers: {
    production: {
      currentLogs: ["*.log", "*.log.1"],
      destination: "deploy@server.example.net",
      identityFile: "~/.ssh/example-temporary",
      transport: "ssh",
      // A host whose user-level WP-CLI packages fatal every command needs them switched off
      wpCliPrefix: "WP_CLI_PACKAGES_DIR=/nonexistent-wp-cli-packages",
    },
    rehearsal: {
      composeFile: "sites/example/local/compose.yaml",
      // The CLI image's newer MariaDB client demands TLS that a local server of live's version doesn't offer
      dumpOptions: ["--skip-ssl"],
      project: "example",
      service: "cli",
      transport: "docker",
    },
  },
  sites: {
    example: {
      docroot: "/var/www/example/public_html",
      logRoot: "/var/www/example/logs",
      quarantineRoot: "/var/www/quarantine/example",
      server: "production",
      smokeTargets: "sites/example/local/smoke-targets.ts",
      url: "https://www.example.org",
    },
    "example-local": {
      docroot: "/var/www/html",
      server: "rehearsal",
      smokeLogin: { password: "localadmin", user: "localadmin" },
      smokeTargets: "sites/example/local/smoke-targets.ts",
      url: "http://localhost:8084",
    },
  },
  snapshotExcludes: [
    "/wp-content/cache/",
    "/wp-content/updraft/",
    "/wp-content/ai1wm-backups/",
  ],
} satisfies Config;
