import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store/memory.js';
import { broadcast } from '../ws/broadcaster.js';
import { resolveAuth, detectProvider } from './auth.js';
import { buildOpenAIHeaders, openAIUrl } from './providers/openai.js';
import {
  translateToAnthropic,
  translateAnthropicResponse,
  buildAnthropicHeaders,
  anthropicUrl,
  OpenAIRequest,
} from './providers/anthropic.js';
import { translateToGemini, translateGeminiResponse, geminiUrl } from './providers/gemini.js';
import { proxyStream } from './streaming.js';
import modelsRouter from './models.js';

const router: Router = Router();

router.use('/models', modelsRouter);
router.get('/health', (_req, res) => res.json({ ok: true }));

const recentRequests: Array<{ model: string; tokens: number; latency: number; time: string }> = [];

function trackRequest(model: string, tokens: number, latency: number): void {
  recentRequests.unshift({ model, tokens, latency, time: new Date().toISOString() });
  if (recentRequests.length > 10) recentRequests.pop();
}

export function getRecentRequests() {
  return [...recentRequests];
}

async function emitTraceEvent(
  sessionId: string,
  stepIndex: number,
  stepType: string,
  input: unknown,
  output: unknown,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const eventId = uuidv4();
  const event = {
    event_id: eventId,
    session_id: sessionId,
    step_index: stepIndex,
    step_type: stepType,
    input,
    output,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  await store.addEvent(event as Parameters<typeof store.addEvent>[0]);
  broadcast(event);
}

router.post('/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as OpenAIRequest;
  const model = body.model ?? 'gpt-4o';
  const provider = detectProvider(model);
  const auth = resolveAuth(req, provider);
  const startTime = Date.now();

  if (!auth.key) {
    return res.status(401).json({
      error: {
        message: 'Interveil Gateway: No API key found. Pass your key in the Authorization: Bearer header, or set OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY environment variables.',
        type: 'authentication_error',
      },
    });
  }

  // Resolve or create session — group proxy requests without headers by day
  const sessionHeader = req.headers['x-interveil-session-id'] as string | undefined;
  const dateStr = new Date().toISOString().split('T')[0];
  const sessionId = sessionHeader ?? `ide-proxy-${dateStr}`;

  const existingSession = await store.getSession(sessionId);
  if (!existingSession) {
    await store.createSession({
      session_id: sessionId,
      name: `Gateway — ${model} — ${new Date().toISOString()}`,
      status: 'running',
      started_at: new Date().toISOString(),
      metadata: { source: 'gateway', badge: 'GATEWAY' },
    });
  }

  const events = await store.getEvents(sessionId);
  const stepIndex = events.length;

  await emitTraceEvent(sessionId, stepIndex, 'LLM_REQUEST', {
    model,
    messages: body.messages,
    tools: body.tools,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    source: 'gateway',
  }, null, { model, timestamp: new Date().toISOString() });

  const isStreaming = body.stream === true;

  if (isStreaming) {
    let targetUrl: string;
    let headers: Record<string, string>;
    let requestBody: string;

    if (provider === 'anthropic') {
      targetUrl = anthropicUrl();
      headers = buildAnthropicHeaders(auth.key);
      requestBody = JSON.stringify(translateToAnthropic(body));
    } else if (provider === 'gemini') {
      // Gemini streaming is complex — fall back to non-streaming
      return handleNonStream(req, res, body, model, provider, auth.key, sessionId, stepIndex + 1, startTime);
    } else {
      targetUrl = openAIUrl('/chat/completions');
      headers = buildOpenAIHeaders(auth.key);
      requestBody = JSON.stringify(body);
    }

    proxyStream(targetUrl, 'POST', headers, requestBody, res, async (result) => {
      const duration_ms = Date.now() - startTime;
      const evts = await store.getEvents(sessionId!);
      await emitTraceEvent(sessionId!, evts.length, 'LLM_RESPONSE', null, {
        content: result.assembled,
        finish_reason: result.finish_reason,
        ...(result.partial ? { partial: true } : {}),
      }, {
        model,
        duration_ms,
        token_usage: result.usage,
        timestamp: new Date().toISOString(),
      });
      trackRequest(model, result.usage?.total_tokens ?? 0, duration_ms);
    });

    return;
  }

  return handleNonStream(req, res, body, model, provider, auth.key, sessionId, stepIndex + 1, startTime);
});

async function handleNonStream(
  _req: Request,
  res: Response,
  body: OpenAIRequest,
  model: string,
  provider: string,
  apiKey: string,
  sessionId: string,
  nextStep: number,
  startTime: number
): Promise<void> {
  let targetUrl: string;
  let headers: Record<string, string>;
  let requestBody: string;

  if (provider === 'anthropic') {
    targetUrl = anthropicUrl();
    headers = buildAnthropicHeaders(apiKey);
    const translated = translateToAnthropic(body);
    delete (translated as Record<string, unknown>).stream;
    requestBody = JSON.stringify(translated);
  } else if (provider === 'gemini') {
    targetUrl = geminiUrl(model, apiKey);
    headers = { 'Content-Type': 'application/json' };
    requestBody = JSON.stringify(translateToGemini(body.messages));
  } else {
    targetUrl = openAIUrl('/chat/completions');
    headers = buildOpenAIHeaders(apiKey);
    const b = { ...body };
    delete (b as Record<string, unknown>).stream;
    requestBody = JSON.stringify(b);
  }

  try {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    };

    const requester = parsed.protocol === 'https:' ? https : http;

    const responseData = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = requester.request(options, (providerRes) => {
        let data = '';
        providerRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        providerRes.on('end', () => resolve({ statusCode: providerRes.statusCode ?? 200, body: data }));
        providerRes.on('error', reject);
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    const duration_ms = Date.now() - startTime;
    let responseJson: Record<string, unknown>;

    try {
      responseJson = JSON.parse(responseData.body) as Record<string, unknown>;
    } catch {
      res.status(502).json({ error: { message: 'Interveil Gateway: invalid response from provider' } });
      return;
    }

    if (responseData.statusCode >= 400) {
      const evts = await store.getEvents(sessionId);
      await emitTraceEvent(sessionId, evts.length, 'ERROR', { status: responseData.statusCode }, responseJson, {
        model, duration_ms, timestamp: new Date().toISOString(),
      });
      res.status(responseData.statusCode).json(responseJson);
      return;
    }

    let finalResponse = responseJson;
    if (provider === 'anthropic') {
      finalResponse = translateAnthropicResponse(responseJson);
    } else if (provider === 'gemini') {
      finalResponse = translateGeminiResponse(responseJson, model);
    }

    const usage = finalResponse.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

    const evts = await store.getEvents(sessionId);
    await emitTraceEvent(sessionId, evts.length, 'LLM_RESPONSE', null, finalResponse, {
      model,
      duration_ms,
      token_usage: usage,
      timestamp: new Date().toISOString(),
    });

    trackRequest(model, usage?.total_tokens ?? 0, duration_ms);
    res.json(finalResponse);
  } catch (err) {
    const evts = await store.getEvents(sessionId);
    await emitTraceEvent(sessionId, evts.length, 'ERROR', null, { message: (err as Error).message }, {
      model, duration_ms: Date.now() - startTime, timestamp: new Date().toISOString(),
    });
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Interveil Gateway: could not reach provider — ${(err as Error).message}` } });
    }
  }
}

router.post('/embeddings', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const model = (body.model as string) ?? 'text-embedding-3-small';
  const provider = detectProvider(model);
  const auth = resolveAuth(req, provider);

  if (!auth.key) {
    return res.status(401).json({ error: { message: 'No API key' } });
  }

  const sessionHeader = req.headers['x-interveil-session-id'] as string | undefined;
  const dateStr = new Date().toISOString().split('T')[0];
  const sessionId = sessionHeader ?? `ide-proxy-${dateStr}`;
  const events = await store.getEvents(sessionId);
  await emitTraceEvent(sessionId, events.length, 'CUSTOM', body, null, { model });

  return res.status(200).json({ object: 'list', data: [], model, usage: { prompt_tokens: 0, total_tokens: 0 } });
});

export default router;
