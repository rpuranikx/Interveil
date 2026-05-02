# Interveil — TypeScript Example

## Prerequisites

1. Start the Interveil server:
   ```bash
   cd ../..
   npm install
   interveil serve
   # Or: npx ts-node src/cli.ts serve
   ```

2. Open http://localhost:3000 in your browser (or it will auto-open)

## Run the example

```bash
cd examples/typescript
npx ts-node basic-agent.ts
```

The example runs a simple multi-step agent that:
1. **Thinks** about a problem (REASONING step)
2. **Searches** for information (TOOL_CALL step)
3. **Analyzes** results (CUSTOM step)
4. **Generates** a report — intentionally fails 50% of the time (ERROR step)
5. **Summarizes** output (CUSTOM step)

Watch the Interveil UI to see each step appear in real time. If the report generation fails, you'll see:
- The failing step highlighted in red with an expanded error view
- The preceding step with a yellow left border
- A failure banner at the top of the trace
