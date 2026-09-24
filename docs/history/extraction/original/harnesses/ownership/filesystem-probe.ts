import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_SOURCE_HEAD = "39171682343754366439b2c0890f5b0f4c3ed891";
const sourceRoot = process.env.LIVE_SOURCE ?? "/tmp/pi-better-openai.qnz8hk";
const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (sourceHead !== EXPECTED_SOURCE_HEAD) {
  throw new Error(`expected ${EXPECTED_SOURCE_HEAD}, found ${sourceHead}`);
}

const queue = (await import(pathToFileURL(join(sourceRoot, "src/live/queue.ts")).href)) as {
  LiveFloorArbiter: new (
    options: Record<string, unknown>,
    callbacks: Record<string, unknown>,
  ) => {
    readonly hasFloor: boolean;
    join(): void;
    tick(): void;
  };
};

function tempDirectory(): string {
  return join(tmpdir(), `luna-live-filesystem-${process.pid}-${Date.now()}-${Math.random()}`);
}

function atomicReplace(path: string, value: unknown, suffix: string): void {
  const temporary = `${path}.${suffix}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function parse(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function runPartialNonPreemptClaimProbe(): unknown {
  const directory = tempDirectory();
  mkdirSync(join(directory, "members"), { recursive: true });
  const floor = join(directory, "floor.json");
  const fd = openSync(floor, "wx");
  try {
    const candidate = new queue.LiveFloorArbiter(
      {
        pid: 2501,
        sessionId: "candidate",
        cwd: "/worktrees/luna",
        policy: "focus",
        directory,
        now: () => 1_000_000,
        isProcessAlive: () => false,
      },
      { onActivated: () => undefined, onDeactivated: () => undefined },
    );
    candidate.join();
    const whileWriterHasFile = {
      fileExists: existsSync(floor),
      bytes: statSync(floor).size,
      parsedClaim: parse(floor),
      candidateHasFloor: candidate.hasFloor,
    };

    writeFileSync(
      fd,
      JSON.stringify({
        holderId: "2500-owner",
        pid: 2500,
        token: "complete",
        claimedAt: 1_000_000,
      }),
    );
    closeSync(fd);
    const parsedClaimBeforeCandidateTick = parse(floor);
    candidate.tick();

    return {
      whileWriterHasFile,
      afterWriterCompletes: {
        parsedClaimBeforeCandidateTick,
        candidateHasFloorAfterTick: candidate.hasFloor,
        finalFloor: parse(floor),
      },
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The successful path closes the descriptor before the tick.
    }
    rmSync(directory, { recursive: true });
  }
}

function runCompareDeleteInterleavingProbe(): unknown {
  const directory = tempDirectory();
  mkdirSync(directory, { recursive: true });
  const floor = join(directory, "floor.json");
  const oldClaim = { holderId: "old", pid: 2600, token: "old-token", claimedAt: 1 };
  const freshClaim = { holderId: "fresh", pid: 2601, token: "fresh-token", claimedAt: 2 };
  try {
    atomicReplace(floor, oldClaim, "old");
    const claimReadByStaleEvaluator = parse(floor);
    atomicReplace(floor, freshClaim, "fresh");
    const claimBeforeUnconditionalDelete = parse(floor);
    rmSync(floor, { force: true });
    return {
      operationLevelOnly: true,
      claimReadByStaleEvaluator,
      claimAfterPeerAtomicReplace: claimBeforeUnconditionalDelete,
      floorExistsAfterStaleEvaluatorDelete: existsSync(floor),
      interpretation:
        "A read-old / peer-replace / unconditional-delete sequence loses the fresh claim.",
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runAtomicReplacementProbe(): unknown {
  const directory = tempDirectory();
  mkdirSync(directory, { recursive: true });
  const floor = join(directory, "floor.json");
  try {
    atomicReplace(floor, { writer: "A", token: "a" }, "writer-a");
    atomicReplace(floor, { writer: "B", token: "b" }, "writer-b");
    return {
      finalJson: parse(floor),
      temporaryFilesLeft: readdirSync(directory).filter((file) => file.endsWith(".tmp")),
      note: "Sequentially exercising the same temp-write/rename primitive leaves one complete JSON value; it does not prove a concurrent read/rename protocol.",
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

const output = {
  source: { root: sourceRoot, head: sourceHead },
  partialNonPreemptClaim: runPartialNonPreemptClaimProbe(),
  compareDeleteInterleaving: runCompareDeleteInterleavingProbe(),
  atomicReplacement: runAtomicReplacementProbe(),
};

console.log(JSON.stringify(output, null, 2));
