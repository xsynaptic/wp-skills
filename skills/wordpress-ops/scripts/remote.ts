import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";

import type { DockerServer, SiteContext, SshServer } from "./config.ts";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface RunOptions {
  input?: string;
  // A file descriptor to stream stdout into, or "inherit" to show stdout and stderr live
  output?: "inherit" | number;
}

export interface Remote {
  readonly docroot: string;
  readonly label: string;
  php<Result>(source: string, wpArguments?: readonly string[]): Promise<Result>;
  // rsync from a directory on the server into a local one; returns rsync's exit code
  pull(
    remoteDirectory: string,
    localDirectory: string,
    rsyncArguments: readonly string[],
    options?: { isLive?: boolean },
  ): Promise<number>;
  run(command: string, input?: string): Promise<CommandResult>;
  script(body: string): Promise<string>;
  scriptToFile(body: string, file: string): Promise<void>;
  wp(wpArguments: readonly string[]): Promise<CommandResult>;
  wpCommand(wpArguments: readonly string[]): string;
}

const prelude = "set -eu\nset -o pipefail\n";

export function quote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

function runLocal(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const [command, ...commandArguments] = argv;
  if (command === undefined) return Promise.reject(new Error("empty command"));
  const output = options.output ?? "pipe";
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, {
      stdio: ["pipe", output, output === "inherit" ? "inherit" : "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 128,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    child.stdin?.end(options.input ?? "");
  });
}

function assertSuccess(result: CommandResult, what: string): string {
  if (result.exitCode === 0) return result.stdout;
  const detail = (result.stderr.trim() || result.stdout.trim())
    .split("\n")
    .slice(-6)
    .join("\n");
  throw new Error(
    `${what} exited ${result.exitCode}${detail ? `:\n${detail}` : ""}`,
  );
}

// WP-CLI and PHP print notices on stdout, while the helpers print their JSON as one final line
export function lastJsonLine(stdout: string, what: string): unknown {
  const line = stdout.trimEnd().split("\n").at(-1);
  if (line === undefined || line === "")
    throw new Error(`${what} printed nothing`);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${what} ended without JSON: ${line.slice(0, 200)}`);
  }
}

function sshOptions(server: SshServer): string[] {
  return [
    ...(server.identityFile
      ? ["-i", server.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=20",
    // Overloaded servers drop idle long jobs without keepalives
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=4",
    // A scan's many calls share one connection; %C keeps each server's socket apart
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=~/.ssh/cm-wordpress-ops-%C",
    "-o",
    "ControlPersist=120",
  ];
}

interface ComposeVolume {
  source?: string;
  target: string;
  type: string;
}

interface Transport {
  argv(command: string): string[];
  label: string;
  rsyncSource(
    remoteDirectory: string,
  ): Promise<{ shellArgs: string[]; source: string }>;
  shell: string;
}

function sshTransport(server: SshServer): Transport {
  const options = sshOptions(server);
  return {
    argv: (command) => ["ssh", ...options, server.destination, command],
    label: `ssh ${server.destination}`,
    rsyncSource: (remoteDirectory) =>
      Promise.resolve({
        shellArgs: [
          "-e",
          ["ssh", ...options].map((word) => quote(word)).join(" "),
        ],
        source: `${server.destination}:${remoteDirectory}/`,
      }),
    shell: "bash",
  };
}

// Containers hold no rsync, so pulls read the host side of the service's bind mounts
function dockerTransport(
  server: DockerServer,
  workspaceRoot: string,
): Transport {
  const compose = [
    "docker",
    "compose",
    "-f",
    path.resolve(workspaceRoot, server.composeFile),
    "-p",
    server.project,
  ];
  let mounts: Promise<ComposeVolume[]> | undefined;

  async function readMounts(): Promise<ComposeVolume[]> {
    const output = assertSuccess(
      await runLocal([...compose, "config", "--format", "json"]),
      "docker compose config",
    );
    const parsed = JSON.parse(output) as {
      services: Record<string, { volumes?: ComposeVolume[] }>;
    };
    return (parsed.services[server.service]?.volumes ?? []).filter(
      (volume) => volume.type === "bind",
    );
  }

  return {
    argv: (command) => [
      ...compose,
      "exec",
      "-T",
      server.service,
      "sh",
      "-c",
      command,
    ],
    label: `docker compose -p ${server.project} exec ${server.service}`,
    rsyncSource: async (remoteDirectory) => {
      mounts ??= readMounts();
      const bindMounts = await mounts;
      const covering = bindMounts.filter(
        (volume) =>
          remoteDirectory === volume.target ||
          remoteDirectory.startsWith(`${volume.target}/`),
      );
      const mount = covering.toSorted(
        (first, second) => second.target.length - first.target.length,
      )[0];
      if (!mount?.source)
        throw new Error(
          `${remoteDirectory} isn't a bind mount from the host in service ${server.service}`,
        );
      return {
        shellArgs: [],
        source: `${path.join(mount.source, path.relative(mount.target, remoteDirectory))}/`,
      };
    },
    shell: "sh",
  };
}

export function connect(context: SiteContext): Remote {
  const { server, site } = context;
  const transport =
    server.transport === "ssh"
      ? sshTransport(server)
      : dockerTransport(server, context.workspace.root);
  const prefix = server.wpCliPrefix ? `${server.wpCliPrefix} ` : "";

  // Some wp-config.php files require siblings by relative path, so WP-CLI starts in the docroot
  // Plugins and themes stay unloaded so site code (an implant included) never runs under WP-CLI
  function wpCommand(wpArguments: readonly string[]): string {
    return `cd ${quote(site.docroot)} && ${prefix}wp --skip-plugins --skip-themes ${wpArguments.map((word) => quote(word)).join(" ")}`;
  }

  async function run(command: string, input?: string): Promise<CommandResult> {
    const result = await runLocal(
      transport.argv(command),
      input === undefined ? {} : { input },
    );
    // Parallel calls race to create the shared socket, and the loser says so on stderr, which reports would print
    return {
      ...result,
      stderr: result.stderr.replaceAll(
        /^ControlSocket .* already exists, disabling multiplexing\r?\n?/gm,
        "",
      ),
    };
  }

  return {
    docroot: site.docroot,
    label: transport.label,
    php: async <Result>(
      source: string,
      wpArguments: readonly string[] = [],
    ) => {
      const result = await run(
        wpCommand(["eval-file", "-", ...wpArguments]),
        source,
      );
      return lastJsonLine(
        assertSuccess(result, `${context.name}: wp eval-file`),
        `${context.name}: wp eval-file`,
      ) as Result;
    },
    pull: async (
      remoteDirectory,
      localDirectory,
      rsyncArguments,
      options = {},
    ) => {
      const { shellArgs, source } =
        await transport.rsyncSource(remoteDirectory);
      const argv = [
        "rsync",
        ...shellArgs,
        ...rsyncArguments,
        source,
        `${localDirectory}/`,
      ];
      const result = await runLocal(
        argv,
        options.isLive ? { output: "inherit" } : {},
      );
      if (result.exitCode !== 0 && result.stderr.trim() !== "")
        console.error(result.stderr.trim());
      return result.exitCode;
    },
    run,
    script: async (body) =>
      assertSuccess(
        await run(`${transport.shell} -s`, prelude + body),
        `${context.name}: remote script`,
      ),
    scriptToFile: async (body, file) => {
      const handle = await open(file, "w");
      try {
        const result = await runLocal(transport.argv(`${transport.shell} -s`), {
          input: prelude + body,
          output: handle.fd,
        });
        assertSuccess(
          result,
          `${context.name}: remote script into ${path.basename(file)}`,
        );
      } finally {
        await handle.close();
      }
    },
    wp: (wpArguments) => run(wpCommand(wpArguments)),
    wpCommand,
  };
}
