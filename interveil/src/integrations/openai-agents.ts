import { InterveillClient } from '../sdk/client.js';

export interface TracedRunnerOptions {
  port?: number;
  host?: string;
  sessionName?: string;
}

export const tracedRunner = {
  async run<TAgent, TInput, TResult>(
    agent: { run?: (input: TInput) => Promise<TResult>; execute?: (input: TInput) => Promise<TResult> },
    input: TInput,
    options: TracedRunnerOptions = {}
  ): Promise<TResult> {
    const client = new InterveillClient({ port: options.port, host: options.host });
    const session = await client.startSession({ name: options.sessionName ?? 'OpenAI Agents SDK run' });
    const { session_id } = session;
    let step = 0;

    await client.emit({
      session_id,
      step_index: step++,
      step_type: 'REASONING',
      input,
      output: null,
      timestamp: new Date().toISOString(),
    });

    const start = Date.now();
    try {
      const runFn = agent.run ?? agent.execute;
      if (!runFn) throw new Error('Agent must have a run() or execute() method');

      const result = await runFn.call(agent, input);

      await client.emit({
        session_id,
        step_index: step++,
        step_type: 'CUSTOM',
        input,
        output: result,
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - start,
      });

      await client.endSession(session_id, 'completed');
      return result;
    } catch (err) {
      await client.emit({
        session_id,
        step_index: step++,
        step_type: 'ERROR',
        input,
        output: null,
        error: { message: (err as Error).message, stack: (err as Error).stack },
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - start,
      });
      await client.endSession(session_id, 'failed');
      throw err;
    }
  },
};
