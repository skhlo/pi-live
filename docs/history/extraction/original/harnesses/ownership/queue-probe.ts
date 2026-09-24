import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  LIVE_QUEUE_STALE_MS: number;
  LiveFloorArbiter: new (
    options: Record<string, unknown>,
    callbacks: Record<string, unknown>,
  ) => {
    readonly id: string;
    readonly hasFloor: boolean;
    readonly focused: boolean | undefined;
    join(): void;
    leave(): void;
    tick(): void;
    setFocused(focused: boolean): void;
  };
  liveQueueDirectory(agentDir: string): string;
};

type Events = {
  activations: string[];
  deactivations: number;
};

type HarnessArbiter = {
  arbiter: InstanceType<typeof queue.LiveFloorArbiter>;
  events: Events;
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function floorHolder(directory: string): string | null {
  const value = readJson(join(directory, "floor.json"));
  if (typeof value !== "object" || value === null || !("holderId" in value)) return null;
  return typeof value.holderId === "string" ? value.holderId : null;
}

function memberFiles(directory: string): string[] {
  try {
    return readdirSync(join(directory, "members"))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function snapshot(directory: string, members: HarnessArbiter[]): unknown {
  return {
    hasFloor: members.map(({ arbiter }) => ({ id: arbiter.id, value: arbiter.hasFloor })),
    floorFileHolder: floorHolder(directory),
    deactivations: members.map(({ arbiter, events }) => ({
      id: arbiter.id,
      value: events.deactivations,
    })),
  };
}

function makeHarness(initialTime = 1_000_000) {
  const directory = `${tmpdir()}/luna-live-ownership-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  let now = initialTime;
  const alivePids = new Set<number>();
  const aliveChecks: number[] = [];
  const members: HarnessArbiter[] = [];

  const make = (pid: number, sessionId: string, policy: "focus" | "fifo"): HarnessArbiter => {
    alivePids.add(pid);
    const events: Events = { activations: [], deactivations: 0 };
    const arbiter = new queue.LiveFloorArbiter(
      {
        pid,
        sessionId,
        cwd: "/worktrees/luna",
        policy,
        directory,
        now: () => now,
        isProcessAlive: (candidate: number) => {
          aliveChecks.push(candidate);
          return alivePids.has(candidate);
        },
      },
      {
        onActivated: (cause: string) => events.activations.push(cause),
        onDeactivated: () => {
          events.deactivations += 1;
        },
      },
    );
    const result = { arbiter, events };
    members.push(result);
    return result;
  };

  return {
    directory,
    members,
    make,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    aliveChecks,
    cleanup: () => rmSync(directory, { recursive: true }),
  };
}

function runFocusPreemptionProbe(): unknown {
  const harness = makeHarness();
  try {
    const alpha = harness.make(2101, "session-alpha", "focus");
    alpha.arbiter.join();
    const beta = harness.make(2102, "session-beta", "focus");
    beta.arbiter.join();
    beta.arbiter.setFocused(true);

    const beforeDisplacedTick = snapshot(harness.directory, [alpha, beta]);
    alpha.arbiter.tick();
    const afterDisplacedTick = snapshot(harness.directory, [alpha, beta]);

    return {
      beforeDisplacedTick,
      afterDisplacedTick,
      activationCauses: [alpha, beta].map(({ arbiter, events }) => ({
        id: arbiter.id,
        values: events.activations,
      })),
    };
  } finally {
    harness.cleanup();
  }
}

function runFocusedPingPongProbe(): unknown {
  const harness = makeHarness();
  try {
    const original = harness.make(2201, "session-original", "focus");
    original.arbiter.join();
    const challengerA = harness.make(2202, "session-a", "focus");
    challengerA.arbiter.join();
    const challengerB = harness.make(2203, "session-b", "focus");
    challengerB.arbiter.join();

    challengerA.arbiter.setFocused(true);
    challengerB.arbiter.setFocused(true);
    original.arbiter.tick();

    const states: Array<{ step: string; snapshot: unknown }> = [
      { step: "B preempts A", snapshot: snapshot(harness.directory, [challengerA, challengerB]) },
    ];

    challengerA.arbiter.tick();
    states.push({
      step: "A's first tick steps down",
      snapshot: snapshot(harness.directory, [challengerA, challengerB]),
    });
    challengerA.arbiter.tick();
    states.push({
      step: "A's next tick preempts B",
      snapshot: snapshot(harness.directory, [challengerA, challengerB]),
    });
    challengerB.arbiter.tick();
    states.push({
      step: "B's first tick steps down",
      snapshot: snapshot(harness.directory, [challengerA, challengerB]),
    });
    challengerB.arbiter.tick();
    states.push({
      step: "B's next tick preempts A",
      snapshot: snapshot(harness.directory, [challengerA, challengerB]),
    });

    return {
      bothRemainFocused:
        challengerA.arbiter.focused === true && challengerB.arbiter.focused === true,
      states,
      activationCauses: [challengerA, challengerB].map(({ arbiter, events }) => ({
        id: arbiter.id,
        values: events.activations,
      })),
    };
  } finally {
    harness.cleanup();
  }
}

function runStaleLiveTakeoverProbe(): unknown {
  const harness = makeHarness();
  try {
    const owner = harness.make(2301, "session-live-owner", "fifo");
    owner.arbiter.join();
    harness.advance(queue.LIVE_QUEUE_STALE_MS + 1);
    const taker = harness.make(2302, "session-taker", "fifo");
    taker.arbiter.join();

    const beforeOwnerResumes = {
      ownerProcessReportedAlive: harness.aliveChecks.includes(2301),
      ownerHasFloor: owner.arbiter.hasFloor,
      takerHasFloor: taker.arbiter.hasFloor,
      floorFileHolder: floorHolder(harness.directory),
      memberFiles: memberFiles(harness.directory),
    };

    owner.arbiter.tick();
    const afterOwnerResumes = {
      ownerHasFloor: owner.arbiter.hasFloor,
      ownerDeactivations: owner.events.deactivations,
      takerHasFloor: taker.arbiter.hasFloor,
      floorFileHolder: floorHolder(harness.directory),
      memberFiles: memberFiles(harness.directory),
    };

    return {
      staleThresholdMs: queue.LIVE_QUEUE_STALE_MS,
      beforeOwnerResumes,
      afterOwnerResumes,
    };
  } finally {
    harness.cleanup();
  }
}

function runMalformedFloorProbe(): unknown {
  const cases = [
    "",
    "{not json",
    "null",
    "{}",
    '{"holderId":"owner","pid":"not-a-number","token":"old","claimedAt":1}',
  ];
  return cases.map((raw) => {
    const harness = makeHarness();
    try {
      mkdirSync(harness.directory, { recursive: true });
      writeFileSync(join(harness.directory, "floor.json"), raw);
      const candidate = harness.make(2401, "session-candidate", "focus");
      candidate.arbiter.join();
      candidate.arbiter.setFocused(true);
      return {
        raw,
        hasFloor: candidate.arbiter.hasFloor,
        activations: candidate.events.activations,
        floorStillExists: existsSync(join(harness.directory, "floor.json")),
        rawAfter: readFileSync(join(harness.directory, "floor.json"), "utf8"),
        memberFiles: memberFiles(harness.directory),
      };
    } finally {
      harness.cleanup();
    }
  });
}

const output = {
  source: { root: sourceRoot, head: sourceHead },
  queueDirectoryFormula: {
    agentA: queue.liveQueueDirectory("/tmp/luna-agent-a"),
    agentB: queue.liveQueueDirectory("/tmp/luna-agent-b"),
  },
  focusPreemption: runFocusPreemptionProbe(),
  focusedChallengerPingPong: runFocusedPingPongProbe(),
  staleButLiveOwnerTakeover: runStaleLiveTakeoverProbe(),
  malformedFloor: runMalformedFloorProbe(),
};

console.log(JSON.stringify(output, null, 2));
