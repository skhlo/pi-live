import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "/tmp/dotfiles-pi-live-spec";
const source = "/tmp/pi-better-openai.qnz8hk";
const directory = join(root, "preview/live-spec/verification");
const profile = "(version 1) (allow default) (deny network*)";
const isolated = {
  ...process.env,
  HOME: join(directory, "empty-home"),
  PI_CODING_AGENT_DIR: join(directory, "empty-agent"),
  NO_PROXY: "*",
};
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"])
  delete isolated[key];
const commands: Array<{ name: string; args: string[] }> = [
  {
    name: "network-denial-guard",
    args: ["node", "--input-type=module", "-e", "import net from 'node:net';const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>{s.destroy();process.exitCode=1});s.on('error',e=>{console.log(e.code);if(e.code!=='EPERM')process.exitCode=1});setTimeout(()=>{s.destroy();process.exitCode=1},2000).unref();"],
  },
  {
    name: "lifecycle",
    args: ["node", "--experimental-strip-types", join(root, "preview/live-spec/lifecycle/lifecycle-probe.ts")],
  },
  ...["queue", "filesystem", "lifecycle"].map((name) => ({
    name: `ownership-${name}`,
    args: ["bun", join(root, `preview/live-spec/ownership/${name}-probe.ts`)],
  })),
  {
    name: "transport",
    args: [join(source, "node_modules/.bin/vitest"), "run", "--root", join(root, "preview/live-spec/transport"), "--config", join(root, "preview/live-spec/transport/vitest.config.ts"), "probe.test.ts", "--reporter", "verbose"],
  },
];
const receipt = {
  createdAt: new Date().toISOString(),
  sourceCommit: "39171682343754366439b2c0890f5b0f4c3ed891",
  description: "Parent verification of upstream behavior probes. Not extraction acceptance tests.",
  runnerSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
  environmentOverrides: { HOME: isolated.HOME, PI_CODING_AGENT_DIR: isolated.PI_CODING_AGENT_DIR, NO_PROXY: isolated.NO_PROXY, proxyVariablesRemoved: true },
  results: [] as Array<{ name: string; argv: string[]; status: number | null; signal: string | null; log: string; logSha256: string; durationMs: number }>,
};
for (const command of commands) {
  const argv = ["-p", profile, "perl", "-e", "alarm 45; exec @ARGV", "--", ...command.args];
  const start = Date.now();
  const result = spawnSync("/usr/bin/sandbox-exec", argv, { cwd: root, env: isolated, encoding: "utf8", timeout: 50_000, maxBuffer: 1024 * 1024 });
  const log = `${command.name}.verified.log`;
  const output = result.stdout + result.stderr + (result.error ? `\n${result.error.name}: ${result.error.message}\n` : "");
  writeFileSync(join(directory, log), output);
  receipt.results.push({ name: command.name, argv: ["/usr/bin/sandbox-exec", ...argv], status: result.status, signal: result.signal, log, logSha256: createHash("sha256").update(output).digest("hex"), durationMs: Date.now() - start });
  writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`${command.name}: exit ${result.status}`);
  assert.equal(result.status, 0, `${command.name} failed`);
}
