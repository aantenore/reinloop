#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { design } from './architect.ts';
import { loadConfig } from './config/load.ts';
import type { Runtime } from './config/runtime.ts';
import { addIntegration, INTEGRATIONS } from './integrations.ts';
import { describeMembers } from './describe.ts';
import type { RunHandle } from './loop.ts';
import { serveMcp } from './mcp/server.ts';
import { consoleSink } from './observe/sinks.ts';
import { defaultModel, missingCredentials } from './presets.ts';
import { CONFIG_FILE, loadProject } from './project.ts';
import { isLoopback, serve } from './serve.ts';
import { isTeam, type Member } from './team.ts';
import type { Approver, RunResult } from './types.ts';
import { errorMessage, truncate } from './util.ts';
import { VERSION } from './version.ts';

const HELP = `reinloop — agents as files, harness included

  reinloop run "task"            Run the default agent (or -a <name>) on a task
  reinloop chat                  Interactive session with an agent
  reinloop new <name>            Create agents/<name>.md from a template
  reinloop create "description"  Let the architect agent design agents/teams for you
  reinloop list                  List agents and teams
  reinloop add [integration]     Connect an existing technology (RAG, memory, GitHub, tracing, evals...)
  reinloop serve                 HTTP API + web console (default http://127.0.0.1:7878)
  reinloop mcp                   Expose agents as MCP tools over stdio
  reinloop resume <runId> [task] Resume an interrupted run or continue a session (needs a file store)
  reinloop runs | validate       Stored runs | check configuration
  reinloop version               Print the version

Options:
  -a, --agent <name>      Agent or team (default: defaultAgent or the only one)
  -m, --model <p/model>   Model for new/create (default: $REINLOOP_MODEL or auto-detected)
  -c, --config <file>     Config file (default: ${CONFIG_FILE} when present)
      --agents <dir>      Agent files directory (default: agents/ and .reinloop/agents/)
      --skills <dir>      Agent Skills directory (default: skills/ and .reinloop/skills/)
  -p, --profile <name>    Config profile overlay
  -y, --yes               Approve tool calls that policy marks "ask"
  -v, --version           Print the version
      --json              Print events as JSON lines
      --debug             Verbose progress on stderr
      --port, --host, --token   Options for serve (token also from REINLOOP_API_TOKEN)
      --allow-host <host>     serve: extra Host accepted (repeatable; localhost and the bound host always are)
      --allow-origin <url>    serve: browser origin allowed to call the API (repeatable; default none)
      --insecure              serve: allow a non-loopback --host without token or identity verifier`;

type Values = Record<string, string | boolean | string[] | undefined>;

function approver(values: Values, rl?: () => Interface): Approver | undefined {
  if (values.yes) return () => true;
  if (!process.stdin.isTTY) return undefined;
  return async ({ call, reason }) => {
    const own = rl ? undefined : createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await (rl?.() ?? own!).question(`? allow ${call.name} ${truncate(JSON.stringify(call.args), 300)} [${reason}] (y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      own?.close();
    }
  };
}

/** Streams top-level text to stdout and progress to stderr, in event order. */
async function render(handle: RunHandle, values: Values): Promise<RunResult> {
  const progress = values.json ? undefined : consoleSink({ level: values.debug ? 'debug' : 'info' });
  let streamed = false;
  let pending = false;
  for await (const ev of handle) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      continue;
    }
    if (ev.type === 'text_delta' && !ev.parentRunId) {
      process.stdout.write(ev.data.text);
      streamed = pending = true;
      continue;
    }
    if (pending && ev.type === 'model_response' && !ev.parentRunId) {
      process.stdout.write('\n');
      pending = false;
    }
    if (ev.type === 'run_end' && !ev.parentRunId && !streamed && ev.data.output) process.stdout.write(`${ev.data.output}\n`);
    progress?.onEvent(ev);
  }
  return handle.result;
}

const exitCode = (r: RunResult) => (r.status === 'completed' ? 0 : r.status === 'stopped' ? 2 : 1);

/**
 * Calls `fn` once on SIGINT (Ctrl+C) or SIGTERM (containers and service managers stop processes with it) and then
 * detaches, so a second signal ends the process the default way. Returns the function that detaches early.
 */
function onShutdown(fn: (signal: NodeJS.Signals) => void): () => void {
  const handler = (signal: NodeJS.Signals) => {
    detach();
    fn(signal);
  };
  const detach = () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  process.on('SIGINT', handler).on('SIGTERM', handler);
  return detach;
}

/** Abort reason of a run ended by a signal. */
const interruption = (signal: NodeJS.Signals) => new Error(signal === 'SIGINT' ? 'interrupted by user' : `interrupted by ${signal}`);

/** The run log outlives the process only with a configured store other than `memory`. */
const durableStore = (rt: Runtime) => rt.config.store !== undefined && rt.config.store.type !== 'memory';

/** Agent names a member runs: itself, or every agent of a team (nested teams included). */
const agentNames = (member: Member): string[] => (isTeam(member) ? member.members.flatMap(agentNames) : [member.name]);

/** Fails before any request when a built-in preset lacks its API key (the check `validate` reports): for the agents of `member`, or all of them. */
async function requireCredentials(rt: Runtime, member?: Member): Promise<void> {
  const only = member && new Set(agentNames(member));
  const agents = Object.fromEntries(Object.entries(rt.config.agents ?? {}).filter(([name]) => !only || only.has(name)));
  const problems = missingCredentials({ ...rt.config, agents });
  if (problems.length) throw new Error(problems.join('\n'));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function template(name: string, values: Values): string {
  const model = values.model ? `model: ${values.model}` : `# model: ${defaultModel()}   (omit to use REINLOOP_MODEL or the auto-detected default)`;
  return `---
description: ${values.description ?? `TODO one line saying what ${name} does`}
${model}
tools: [${(values.tools as string | undefined) ?? 'read_file, list_dir, search_files'}]
budget: { maxTurns: 30 }
---
You are ${name}.

Goal: TODO describe the outcome this agent is responsible for.

Method:
1. Inspect before acting; never guess.
2. Keep answers short and concrete.
`;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string', short: 'a' },
      model: { type: 'string', short: 'm' },
      config: { type: 'string', short: 'c' },
      agents: { type: 'string', multiple: true },
      skills: { type: 'string', multiple: true },
      profile: { type: 'string', short: 'p' },
      yes: { type: 'boolean', short: 'y' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      debug: { type: 'boolean' },
      description: { type: 'string', short: 'd' },
      tools: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      'allow-host': { type: 'string', multiple: true },
      'allow-origin': { type: 'string', multiple: true },
      insecure: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version || command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const project = () => loadProject({ config: values.config, agentsDir: values.agents, skillsDir: values.skills, profile: values.profile });

  switch (command) {
    case 'new':
    case 'init': {
      const name = command === 'init' ? 'assistant' : rest[0];
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('usage: reinloop new <name>   (letters, digits, - and _)');
      const file = join('agents', `${name}.md`);
      if (existsSync(file)) throw new Error(`${file} already exists`);
      await mkdir('agents', { recursive: true });
      await writeFile(file, template(name, values));
      console.log(`created ${file}\nnext: edit it, then  reinloop run -a ${name} "your task"`);
      return 0;
    }
    case 'create': {
      const request = rest.join(' ').trim() || (await readStdin());
      if (!request) throw new Error('usage: reinloop create "what the agents should do"');
      const { result, problems } = await design(request, {
        cwd: process.cwd(),
        model: values.model,
        approve: approver(values),
        onHandle: (h) => render(h, values),
      });
      for (const p of problems) console.error(`still invalid: ${p}`);
      return problems.length ? 1 : exitCode(result);
    }
    case 'add': {
      const name = rest[0];
      if (!name) {
        const width = Math.max(...Object.keys(INTEGRATIONS).map((k) => k.length));
        for (const [key, it] of Object.entries(INTEGRATIONS)) console.log(`${key.padEnd(width)}  ${it.kind.padEnd(13)} ${it.description}`);
        console.log('\nreinloop add <name>   (writes the configuration; the technology itself stays upstream)');
        return 0;
      }
      const { changed, next } = await addIntegration(name, { configPath: values.config ?? CONFIG_FILE, agent: values.agent });
      console.log(`updated ${changed} (source: ${INTEGRATIONS[name]!.source})\nnext:\n${next.map((n) => `  - ${n}`).join('\n')}`);
      return 0;
    }
    case 'validate': {
      if (values.config) await loadConfig(values.config, { profile: values.profile, onWarning: () => {} }); // project() reports the warnings
      const rt = await project();
      try {
        for (const name of rt.names()) {
          const member = await rt.agent(name);
          // Unpriced models (every local one) cost 0, so a cost limit alone never stops them.
          if (!isTeam(member) && member.budget?.maxCostUsd !== undefined && !member.model.pricing) {
            console.error(`warning: agent "${name}" sets budget.maxCostUsd but ${member.model.model} has no price table, so its cost stays 0 and the limit never stops it (add "pricing" to the config)`);
          }
        }
        for (const warning of missingCredentials(rt.config)) console.error(`warning: ${warning}`);
        console.log(`ok: ${rt.names().join(', ')}`);
      } finally {
        await rt.close();
      }
      return 0;
    }
  }

  const rt = await project();
  try {
    switch (command) {
      case 'list':
      case 'agents':
        for (const m of describeMembers(rt)) {
          const detail = m.kind === 'team' ? `team · ${m.pattern}` : `${m.model} · ${(m.tools ?? []).join(', ') || 'no tools'}`;
          console.log(`${m.name}${m.name === rt.config.defaultAgent ? ' (default)' : ''}  [${detail}]${m.description ? `\n    ${m.description}` : ''}`);
        }
        return 0;
      case 'runs':
        console.log(((await rt.store.list?.()) ?? []).join('\n'));
        return 0;
      case 'serve': {
        await requireCredentials(rt);
        const token = values.token ?? process.env.REINLOOP_API_TOKEN;
        const served = await serve(rt, { port: values.port ? Number(values.port) : undefined, host: values.host, token, allowedHosts: values['allow-host'], allowedOrigins: values['allow-origin'], insecure: values.insecure, approve: values.yes ? () => true : undefined });
        // Off loopback, clients reach the server through a name or address of their own: it must be allow-listed.
        const hosts = values.host && !isLoopback(values.host) ? `; Host must be the bound host, localhost or an --allow-host name (also serve.allowedHosts), see docs/configuration.md#serve` : '';
        console.error(`reinloop serving ${rt.names().join(', ')} at ${served.url}${token ? ' (token required)' : ''}${hosts}`);
        await new Promise<void>((resolve) => onShutdown(() => resolve()));
        await served.close();
        return 0;
      }
      case 'mcp': {
        const stop = new AbortController();
        const detach = onShutdown((signal) => stop.abort(interruption(signal)));
        await serveMcp(rt, { approve: values.yes ? () => true : undefined, signal: stop.signal }).finally(detach);
        return 0;
      }
      case 'chat': {
        await requireCredentials(rt, await rt.agent(values.agent));
        let rl: Interface | undefined;
        let runId: string | undefined;
        let current: RunHandle | undefined;
        let done = false;
        // SIGINT ends the answer in progress, or the chat when none is; SIGTERM ends the chat (after that answer's
        // run_end is recorded).
        let quit!: () => void;
        const quitting = new Promise<string>((resolve) => (quit = () => ((done = true), resolve(''))));
        const onSignal = (signal: NodeJS.Signals) => {
          current?.abort(interruption(signal));
          if (signal !== 'SIGINT' || !current) quit();
        };
        // In a terminal, Ctrl+C and Ctrl+D never reach the process: readline closes itself, which counts as SIGINT (the
        // next prompt opens a new interface). An input pipe that ended quits once the answer is complete.
        const getRl = () =>
          (rl ??= createInterface({ input: process.stdin, output: process.stdout }).once('close', () => {
            rl = undefined;
            if (process.stdin.isTTY) onSignal('SIGINT');
            else quit();
          }));
        const approve = approver(values, getRl);
        process.on('SIGINT', onSignal).on('SIGTERM', onSignal);
        try {
          console.error(`chat with ${values.agent ?? (rt.config.defaultAgent || rt.names()[0])} — empty line or /exit to quit`);
          while (!done) {
            // The prompt must not contain a newline: readline redraws it on every edit (e.g. backspace).
            process.stdout.write('\n');
            // A question readline cancelled (Ctrl+C, Ctrl+D) reads as an empty line.
            const line = (await Promise.race([getRl().question('> ').catch(() => ''), quitting])).trim();
            if (!line || line === '/exit') break;
            current = await rt.stream(values.agent, line, { runId, approve });
            runId = (await render(current, values)).runId;
            current = undefined;
          }
        } finally {
          process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
          rl?.close();
        }
        return 0;
      }
      case 'run':
      case 'resume': {
        const runId = command === 'resume' ? rest.shift() : undefined;
        if (command === 'resume' && !runId) throw new Error('usage: reinloop resume <runId> [task]');
        if (command === 'resume' && !durableStore(rt)) throw new Error(`nothing to resume: the default memory store keeps no run between commands (set "store": { "type": "file" } in ${CONFIG_FILE})`);
        const input = rest.join(' ').trim() || (await readStdin());
        if (command === 'run' && !input) throw new Error('usage: reinloop run "task"');
        await requireCredentials(rt, await rt.agent(values.agent));
        const handle = await rt.stream(values.agent, input || undefined, { runId, approve: approver(values) });
        const detach = onShutdown((signal) => handle.abort(interruption(signal)));
        const result = await render(handle, values).finally(detach);
        // The console sink already printed the status and reason; a run that made progress into a durable log can go on.
        if (!values.json && result.status !== 'completed' && result.turns > 0 && durableStore(rt)) process.stderr.write(`resume with: reinloop resume ${result.runId}\n`);
        return exitCode(result);
      }
      default:
        throw new Error(`unknown command "${command}"\n\n${HELP}`);
    }
  } finally {
    await rt.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    process.exit(1);
  },
);
