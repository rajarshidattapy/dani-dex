// Two registries share one temporary directory: the instance registry a
// `dev:automation` command reads to find a worktree's app, and the stack
// registry `bun run dev` publishes its ports and pids to. Both are written by
// one developer's dev processes and read by their tooling, so both need the
// same three things, and neither can afford its own version of them:
//
//   - a directory no other account can write, because a planted record names a
//     pid and a port that a mutation command would then treat as this
//     worktree's app;
//   - a write a concurrent reader cannot catch half-finished, because a reader
//     deletes what it cannot parse and would drop a record that was still
//     being written;
//   - a way to tell a live process from a recycled pid, because a record
//     outlives a process killed with SIGKILL.

import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface DirectoryOwnership {
  uid: number;
  mode: number;
  symbolicLink: boolean;
}

export interface WindowsDirectorySecurity {
  ownerIsCurrentUser: boolean;
  writableByUntrustedAccount: boolean;
}

// Publishing into a directory somebody else controls is worse than not
// publishing at all: they could replace a record with a forged one naming this
// worktree, a live pid and a CDP port of their choosing, and a mutation command
// would treat that port as the named instance it is allowed to drive. So this
// fails closed rather than trusting that `chmod` worked.
export function assertOwnerOnlyDirectory(
  directory: string,
  stats: DirectoryOwnership,
  owner = process.getuid?.(),
): void {
  if (stats.symbolicLink || (owner !== undefined && stats.uid !== owner)) {
    throw new Error(
      `${directory} is not owned by this user, so dev instances will not be published there. ` +
        "Remove it and start `bun run dev` again.",
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `${directory} is accessible to other accounts (mode ${(stats.mode & 0o777).toString(8)}). ` +
        "Remove it and start `bun run dev` again: a registry another account can write lets it choose " +
        "which app an automation command drives.",
    );
  }
}

export function assertWindowsOwnerOnlyDirectory(directory: string, security: WindowsDirectorySecurity): void {
  if (!security.ownerIsCurrentUser || security.writableByUntrustedAccount) {
    throw new Error(
      `${directory} is not owned exclusively by this Windows account, so dev instances will not be published there. ` +
        "Remove it and start `bun run dev` again.",
    );
  }
}

export function assertRegistryDirectoryOwnership(directory: string): void {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${directory} is not owned by this user, so dev instances will not be published there. ` +
        "Remove it and start `bun run dev` again.",
    );
  }
  if (process.platform === "win32") {
    assertWindowsOwnerOnlyDirectory(directory, readWindowsDirectorySecurity(directory));
    return;
  }
  assertOwnerOnlyDirectory(directory, {
    uid: stats.uid,
    mode: stats.mode,
    symbolicLink: false,
  });
}

function readWindowsDirectorySecurity(directory: string): WindowsDirectorySecurity {
  const script = [
    "$path = [Console]::In.ReadToEnd()",
    "try {",
    "  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  $acl = Get-Acl -LiteralPath $path",
    "  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "  $trusted = @($identity, 'S-1-5-18', 'S-1-5-32-544')",
    "  $dangerous = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership",
    "  $untrustedWrite = $false",
    "  foreach ($rule in $acl.Access) {",
    "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }",
    "    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    if (($trusted -contains $sid) -or (($rule.FileSystemRights -band $dangerous) -eq 0)) { continue }",
    "    $untrustedWrite = $true",
    "    break",
    "  }",
    '  Write-Output "$($owner -eq $identity)|$untrustedWrite"',
    "} catch {",
    "  Write-Output 'false|true'",
    "}",
  ].join("\n");
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    input: directory,
    timeout: 5_000,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  const [ownerIsCurrentUser, writableByUntrustedAccount] = result.split("|");
  return {
    ownerIsCurrentUser: ownerIsCurrentUser === "True",
    writableByUntrustedAccount: writableByUntrustedAccount === "True",
  };
}

// Owner-only, because the path is predictable and shared: on a multi-account
// Linux box the default 0755/0644 would let any local user read which worktree
// and profile a developer has open. `chmod` after `mkdir` covers a directory
// that already existed with wider modes; it can only fail when the directory
// belongs to someone else, and then the assertion below fails anyway.
export function ensureOwnerOnlyDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${directory} is not owned by this user, so dev instances will not be published there. ` +
          "Remove it and start `bun run dev` again.",
      );
    }
    const security = readWindowsDirectorySecurity(directory);
    assertWindowsOwnerOnlyDirectory(directory, { ...security, writableByUntrustedAccount: false });
    tightenWindowsDirectoryPermissions(directory);
  } else {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Not ours to tighten - asserted below, which is what fails closed.
    }
  }
  assertRegistryDirectoryOwnership(directory);
}

function tightenWindowsDirectoryPermissions(directory: string): void {
  const identity = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${identity}:(OI)(CI)F`], {
    timeout: 5_000,
    stdio: "ignore",
  });
}

// Written through a sibling and renamed into place. A plain write truncates
// first, and a reader that hits that window sees an unparseable file and
// deletes it as corrupt - which would leave a dev process that just started
// undiscoverable until it restarts. `rename` within one directory is atomic, so
// a reader sees either the old record or the whole new one.
//
// Unlink first, then create exclusively: `wx` refuses to follow a pre-created
// symlink, so a leftover or planted staging path cannot redirect this write
// outside the registry. Unlinking a symlink removes the link, not its target.
export function writeRegistryFile(target: string, contents: string): void {
  const staging = `${target}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  const handle = openSync(staging, "wx", 0o600);
  try {
    writeFileSync(handle, contents, "utf8");
  } finally {
    closeSync(handle);
  }
  renameSync(staging, target);
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `startedAt` is `Date.now()` taken right after `spawn`, so the process behind
// an honest record always started at or before it. `ps` reports whole seconds,
// which can only round downwards, and the grace covers a clock the developer
// nudged between the two readings.
const PROCESS_START_GRACE_MS = 2_000;

// Signal 0 proves only that *something* holds that pid. A dev process killed
// with SIGKILL leaves its record behind, pids get recycled, and an unrelated
// process inheriting 4242 would keep that record - and the ports beside it -
// looking like this worktree's live dev stack. Comparing when the process
// actually started separates them: a recycled pid always started after the
// record was written.
export function isRecordedProcess(record: { startedAt: number }, processStartedAt: number | null): boolean {
  // Unverifiable, so this cannot be the fail-closed check on its own: `ps` is
  // absent on Windows and can be denied. Each registry carries a second check
  // that still refuses a stale claim when the start time is unknown.
  if (processStartedAt === null) return true;
  return processStartedAt <= record.startedAt + PROCESS_START_GRACE_MS;
}

// Wall-clock start of a live process, or null when it cannot be read. `lstart`
// is a full local timestamp on both macOS and Linux; Windows has no `ps` of
// this kind, so PowerShell answers the same question there. A stop command
// refuses to signal a pid this cannot date, so returning null is safe but not
// free: it costs the developer the command.
export function readProcessStartedAt(pid: number): number | null {
  if (process.platform === "win32") return readWindowsProcessStartedAt(pid);
  try {
    const reported = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Date.parse(reported);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function isLiveRecordedProcess(entry: { pid: number; startedAt: number }): boolean {
  if (!isProcessAlive(entry.pid)) return false;
  return isRecordedProcess(entry, readProcessStartedAt(entry.pid));
}

function readWindowsProcessStartedAt(pid: number): number | null {
  try {
    const reported = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = Date.parse(reported);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export type RecordedProcessState = "live" | "gone" | "unverified";

// The fail-closed half of `isRecordedProcess`, for the caller that is about to
// *signal* the pid rather than read it. Discovery can accept an unknown start
// time and be wrong about which app it drives; a stop command cannot, because
// being wrong there means sending SIGTERM to whatever unrelated program
// inherited that pid. "unverified" is not "live": it is the answer the caller
// has to handle, by leaving the process alone and saying so.
export function verifyRecordedProcess(
  entry: { pid: number; startedAt: number },
  readStartedAt: (pid: number) => number | null = readProcessStartedAt,
): RecordedProcessState {
  if (!isProcessAlive(entry.pid)) return "gone";
  const startedAt = readStartedAt(entry.pid);
  if (startedAt === null) return "unverified";
  return isRecordedProcess(entry, startedAt) ? "live" : "gone";
}

// Whether *anything* is left in the process group a detached child leads. A
// group outlives its leader: electron-vite exits, and the Electron it started
// keeps the renderer port. Signal 0 to the negated pid asks about the group,
// and EPERM is a yes - the group exists and belongs to somebody else.
export function isProcessGroupAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  // Windows has no process groups to ask about.
  if (platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
