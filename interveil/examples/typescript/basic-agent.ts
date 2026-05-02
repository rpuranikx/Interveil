/**
 * Interveil — Basic TypeScript Agent Example
 *
 * This example shows how to wrap a simple agent with trace().
 * Run with: npx ts-node examples/typescript/basic-agent.ts
 */

import { trace, InterveillClient } from '../../src/index.js';

class SimpleAgent {
  async think(problem: string): Promise<string> {
    console.log(`[Agent] Thinking about: ${problem}`);
    await sleep(80);
    return `I should break this into steps: 1) Search for info, 2) Analyze results, 3) Summarize`;
  }

  async search(query: string): Promise<{ results: string[] }> {
    console.log(`[Agent] Searching: ${query}`);
    await sleep(340);
    return {
      results: [
        `Result 1: Information about ${query}`,
        `Result 2: More details on ${query}`,
        `Result 3: Related topic: ${query} advanced`,
      ],
    };
  }

  async analyze(data: unknown): Promise<string> {
    console.log(`[Agent] Analyzing results...`);
    await sleep(120);
    return `Analysis complete: Found 3 relevant results, highest confidence on result 1`;
  }

  async generateReport(analysis: string): Promise<string> {
    console.log(`[Agent] Generating report...`);
    await sleep(200);
    // Intentionally fail to demonstrate error highlighting
    if (Math.random() < 0.5) {
      throw new Error('Report generation failed: template not found');
    }
    return `Final report based on: ${analysis}`;
  }

  async summarize(report: string): Promise<string> {
    console.log(`[Agent] Summarizing...`);
    await sleep(60);
    return `Summary: ${report.slice(0, 100)}`;
  }
}

async function run() {
  const agent = new SimpleAgent();
  const tracedAgent = trace(agent, {
    sessionName: 'basic-agent-demo',
    agentId: 'simple-agent-v1',
    verbose: true,
    autoOpen: true,
  });

  try {
    const thought = await tracedAgent.think('How to improve developer productivity?');
    const searchResults = await tracedAgent.search('developer productivity tools 2025');
    const analysis = await tracedAgent.analyze(searchResults);
    const report = await tracedAgent.generateReport(analysis);
    const summary = await tracedAgent.summarize(report);
    console.log('\n[Agent] Done!', summary);
  } catch (err) {
    console.error('\n[Agent] Run failed (this is intentional for demo purposes):', (err as Error).message);
    console.log('[Agent] Check the Interveil UI to see the failure highlighted in red!');
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

run().catch(console.error);
