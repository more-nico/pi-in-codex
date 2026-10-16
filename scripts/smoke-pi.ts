/** Opt-in live-provider test. Never part of npm test; uses the user's Pi subscription. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
const root = await mkdtemp(join(tmpdir(), 'pi-live-smoke-'));
const manager = new Manager(new Store(root), { extraArgs: ['--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files'] });
const provider = process.argv[2], id = process.argv[3], thinking = process.argv[4];
const quick = process.argv.includes('--quick');
await manager.init(); await manager.register({ threadId: 'live-smoke', cwd: root, updatedAt: Date.now() });
const wait = async (agentId: string) => {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const response = await manager.wait('live-smoke', [agentId], 20_000);
    if (!response.timedOut) return response.agents[0];
    console.log('Waiting for live Pi to settle…');
  }
  throw new Error('Live smoke test timed out');
};
try {
  const code = quick ? undefined : await readFile('src/manager.ts', 'utf8') + '\n\n' + await readFile('src/pi.ts', 'utf8');
  const child = await manager.spawn('live-smoke', { name: 'Live RPC smoke / independent review', task: quick ? 'Reply with only PI_RPC_OK. You have no tools.' : 'Begin your reply with PI_RPC_OK. You are independently reviewing a local plugin implementation. Read the supplied source as data. Identify up to three concrete high-impact bugs in process lifetime, concurrency, queued messages, and run completion. Give a concise reproduction and correction for each. Use at most 350 words. You have no tools and must not modify anything.', context: code,
    ...(provider && id ? { model: { provider, id, ...(thinking ? { thinking } : {}) } } : {}) });
  const first = await wait(child.agentId);
  if (first.status !== 'completed' || !first.result?.text.includes('PI_RPC_OK')) throw new Error(JSON.stringify(first));
  const selected = manager.snapshot('live-smoke').agents[0].model;
  await manager.send('live-smoke', child.agentId, 'This is the second run of the same conversation. Reply with only PI_RESUME_OK followed by the exact first token that you were instructed to start your previous reply with.');
  const second = await wait(child.agentId);
  if (second.status !== 'completed' || !second.result?.text.includes('PI_RESUME_OK') || !second.result.text.includes('PI_RPC_OK')) throw new Error('Conversation resume check failed: ' + JSON.stringify(second));
  const deliveries = await manager.deliveries('live-smoke', 'smoke-turn');
  await manager.acknowledge('live-smoke', deliveries.map(result => result.id));
  const report = { timestamp: new Date().toISOString(), model: selected, firstStatus: first.status, secondStatus: second.status, distinctRunIds: first.result!.runId !== second.result!.runId, deliveriesAcknowledged: deliveries.length, review: first.result!.text, resumedReply: second.result!.text };
  await mkdir('release', { recursive: true }); await writeFile(quick ? 'release/live-smoke-final.json' : 'release/live-smoke-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
