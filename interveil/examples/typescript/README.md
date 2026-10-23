# Interveil — TypeScript Example

From the `interveil/` directory, after `pnpm install && pnpm build` at the repo root:

```bash
node dist/cli.js serve                          # terminal 1
npx ts-node -T examples/typescript/basic-agent.ts  # terminal 2
```

The dashboard opens at http://localhost:3000. The example runs a five-step agent:

1. **think** → `REASONING`
2. **search** → `CUSTOM`
3. **analyze** → `CUSTOM`
4. **generateReport** → fails 50% of the time to show error highlighting (`ERROR`)
5. **summarize** → `CUSTOM`

When a step fails, the dashboard highlights it in red, marks the preceding step, and shows a failure banner.
