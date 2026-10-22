import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const configFileName = "wordpress-ops.config.ts";

interface ServerBase {
  // Globs matched inside a site's log root: the current and previous day's files
  currentLogs?: string[];
  // mysqldump options appended to every `wp db export`
  dumpOptions?: string[];
  // Words placed before `wp`, such as an environment assignment
  wpCliPrefix?: string;
}

export interface SshServer extends ServerBase {
  // `user@host`, or a Host alias from ~/.ssh/config
  destination: string;
  identityFile?: string;
  transport: "ssh";
}

export interface DockerServer extends ServerBase {
  // Relative to the workspace root
  composeFile: string;
  project: string;
  // A running service with WP-CLI, whose docroot and log root are bind mounts from the host
  service: string;
  transport: "docker";
}

export type Server = DockerServer | SshServer;

export interface SmokeLogin {
  password: string;
  user: string;
}

export interface Site {
  // Paths as the server, or the service's container, sees them
  docroot: string;
  logRoot?: string;
  quarantineRoot?: string;
  server: string;
  // An administrator the job already holds; on a live site a password login can send the owner a security plugin's login alert
  smokeLogin?: SmokeLogin;
  // Relative to the workspace root
  smokeTargets?: string;
  url: string;
}

export interface Config {
  servers: Record<string, Server>;
  sites: Record<string, Site>;
  // Docroot-relative paths anchored with a leading slash, such as caches and backup-plugin folders
  snapshotExcludes?: string[];
}

export interface SmokeTarget {
  body?: Record<string, string>;
  isAdmin?: boolean;
  // The whole body must equal the marker
  isExact?: boolean;
  label: string;
  // Text only a fully rendered response of this kind contains
  marker: string;
  method?: "GET" | "POST";
  path: string;
  status?: number;
}

export interface SmokeTargets {
  deep: SmokeTarget[];
  // Front-end pages; the runner adds wp-admin and admin-ajax.php after them
  required: SmokeTarget[];
}

export interface Workspace {
  config: Config;
  root: string;
}

export interface SiteContext {
  name: string;
  server: Server;
  site: Site;
  workspace: Workspace;
}

function findConfig(start: string): string | undefined {
  let directory = path.resolve(start);
  for (;;) {
    const candidate = path.join(directory, configFileName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function loadWorkspace(): Promise<Workspace> {
  const file = findConfig(process.cwd());
  if (!file) {
    throw new Error(
      `no ${configFileName} in ${process.cwd()} or above; start from scripts/wordpress-ops.config.example.ts`,
    );
  }
  const imported = (await import(pathToFileURL(file).href)) as {
    default?: Config;
  };
  const config = imported.default;
  if (!config) throw new Error(`${file} has no default export`);

  for (const [name, site] of Object.entries(config.sites)) {
    if (!Object.hasOwn(config.servers, site.server)) {
      throw new Error(
        `site ${name} names server ${site.server}, which ${configFileName} doesn't define`,
      );
    }
  }
  const unanchored = (config.snapshotExcludes ?? []).filter(
    (exclude) => !exclude.startsWith("/"),
  );
  if (unanchored.length > 0) {
    throw new Error(
      `snapshotExcludes must start with "/": ${unanchored.join(", ")}`,
    );
  }
  return { config, root: path.dirname(file) };
}

export function siteContext(workspace: Workspace, name: string): SiteContext {
  const site = workspace.config.sites[name];
  if (!site) {
    throw new Error(
      `unknown site ${name}; known: ${Object.keys(workspace.config.sites).join(", ")}`,
    );
  }
  const server = workspace.config.servers[site.server];
  if (!server)
    throw new Error(`site ${name} names unknown server ${site.server}`);
  return { name, server, site, workspace };
}

export function positionalArguments(): string[] {
  return process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function flagValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
}

// No names means every site in the config
export function selectSites(workspace: Workspace): SiteContext[] {
  const requested = positionalArguments();
  const names =
    requested.length > 0 ? requested : Object.keys(workspace.config.sites);
  return names.map((name) => siteContext(workspace, name));
}

export function siteDirectory(context: SiteContext): string {
  return path.join(context.workspace.root, "sites", context.name);
}

export function timestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}
