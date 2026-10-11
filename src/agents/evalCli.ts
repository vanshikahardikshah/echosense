import { existsSync, readFileSync } from 'node:fs';
import { evaluate, evaluateClaude, formatTable, runTrial } from './eval';
import { llmFromEnv } from './llm';
import { LAYOUT, SCENARIOS } from './sim';

function loadEnv(): void {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  if (a.includes('--claude')) {
    loadEnv();
    const cfg = { ...llmFromEnv(), mode: 'agent' as const };
    if (!cfg.apiKey) {
      console.log('Put ANTHROPIC_API_KEY in .env first.');
      return;
    }
    const n = Number(a[a.indexOf('--claude') + 1]) || 3;
    const only = a.includes('--only') ? a[a.indexOf('--only') + 1].split(',') : null;
    console.log(`Claude agents (${cfg.model}) vs rule agents, ${n} trials per scenario. This makes real API calls.\n`);
    const table = await evaluateClaude(n, { cfg, budgetMs: 45000 }, only ? SCENARIOS.filter((s) => only.includes(s.key)) : SCENARIOS, (s) => console.log(s));
    console.log(`\n${table}`);
    return;
  }
  const show = a.indexOf('--show');
  if (show >= 0) {
    const spec = SCENARIOS.find((s) => s.key === a[show + 1]) ?? SCENARIOS[0];
    const seed = Number(a[show + 2] ?? 1);
    const r = await runTrial(spec, seed, LAYOUT.slice(0, a.includes('--phones') ? Number(a[a.indexOf('--phones') + 1]) : 3));
    if (a.includes('--map')) r.incidents = r.incidentsMap;
    console.log(`${spec.title} (seed ${seed}):`, JSON.stringify(r.decisions));
    for (const inc of r.incidents) {
      console.log(`\nIncident ${inc.incident.id}: trigger ${inc.incident.trigger.name} ${inc.incident.trigger.kind} (${inc.incident.trigger.detail})`);
      for (const rep of inc.reports) console.log(' ', rep.name, JSON.stringify({ ...rep.sound, ...rep.sonar, imu: rep.imu, verdict: rep.localVerdict }));
      for (const p of inc.positions) console.log(`  R${p.round} ${p.agent.padEnd(9)} ${p.stance.padEnd(10)} ${p.confidence.toFixed(2)} ${p.argument}`);
      console.log(' =>', inc.outcome.kind, inc.outcome.headline, inc.outcome.quarantined);
    }
    return;
  }
  const n = Number(a[a.indexOf('--trials') + 1] ?? 50) || 50;
  const np = Number(a[a.indexOf('--phones') + 1] ?? 3) || 3;
  const t = await evaluate(n, SCENARIOS, LAYOUT.slice(0, a.includes('--phones') ? np : 3));
  console.log(`\nWitness evaluation: ${n} randomized trials per scenario, ${a.includes('--phones') ? np : 3} phones\n`);
  console.log(formatTable(t));
}
void main();
