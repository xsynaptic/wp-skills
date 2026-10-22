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
