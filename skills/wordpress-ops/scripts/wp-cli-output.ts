export function summarizeCoreChecksums(output: string): {
  flags: string[];
  isUnavailable: boolean;
} {
  const modified =
    output.match(/File doesn't verify against checksum/g)?.length ?? 0;
  const extra = output.match(/should not exist/g)?.length ?? 0;
  const missing = output.match(/File doesn't exist/g)?.length ?? 0;
  const flags: string[] = [];
  if (modified > 0) flags.push(`**${modified} modified core files**`);
  if (extra > 0) flags.push(`${extra} files core doesn't ship`);
  if (missing > 0) flags.push(`${missing} core files missing`);
  const isVerified = /^Success:/m.test(output);
  return { flags, isUnavailable: !isVerified && flags.length === 0 };
}

// WP-CLI lists only failures, so a run whose list or skip warnings can't be read vouches for no plugin
export function unverifiedPlugins(
  failed: string[],
  stderr: string,
  isComplete: boolean,
): null | Set<string> {
  if (!isComplete) return null;
  const skipped = stderr
    .matchAll(
      /Could not retrieve the checksums for version \S+ of plugin ([^\s,]+), skipping\./g,
    )
    .map((match) => match[1] ?? "")
    .toArray();
  const warnings = stderr.match(/Could not retrieve the checksums/g)?.length;
  if (skipped.length !== (warnings ?? 0)) return null;
  return new Set([...failed, ...skipped]);
}

export function parseUpdates(output: string): Map<string, string> {
  const updates = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("[")) continue;
    for (const entry of JSON.parse(line) as {
      name: string;
      update_version: string;
    }[]) {
      if (entry.update_version) updates.set(entry.name, entry.update_version);
    }
  }
  return updates;
}
