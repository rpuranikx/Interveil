import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { ensureSession, recordEvent } from '../store/record.js';
import { resolveAuth, detectProvider } from './auth.js';
import { buildOpenAIHeaders, openAIUrl } from './providers/openai.js';
import {
  translateToAnthropic,
  translateAnthropicResponse,
  buildAnthropicHeaders,
  anthropicUrl,
  createAnthropicStreamTranslator,
  OpenAIRequest,
} from './providers/anthropic.js';
import {
  translateToGemini, translateGeminiResponse, geminiUrl, buildGeminiHeaders, createGeminiStreamTranslator,
} from './providers/gemini.js';
import { StreamTranslator } from './providers/stream-translation.js';
import { proxyStream, UPSTREAM_IDLE_TIMEOUT_MS } from './streaming.js';
import { toolCallsInResponse, withholdToolCalls } from './enforcement.js';
import { gateToolCalls, gatewayContext, trackRequest } from './gate.js';
import nativeRouter from './native-proxy.js';
import modelsRouter from './models.js';

export { getRecentRequests } from './gate.js';

const router: Router = Router();

router.use('/models', modelsRouter);
router.get('/health', (_req, res) => res.json({ ok: true }));
// Anthropic Messages and OpenAI Responses, passed through in their own formats.
router.use(nativeRouter);

router.post('/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as OpenAIRequest;
  const model = body.model ?? 'gpt-4o';
  const provider = detectProvider(model);
  const auth = resolveAuth(req, provider, req.app.locals.security);
  const startTime = Date.now();

  if (!auth.key) {
    return res.status(401).json({
      error: {
        message: 'Interveil Gateway: No API key found. Pass your key in the Authorization: Bearer header, or set OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY environment variables.',
        type: 'authentication_error',
      },
    });
  }

  const ctx = await gatewayContext(req, res, model, (message) => ({ error: { message, type: 'policy_violation' } }));
  if (!ctx) return;
  const { sessionId, agentId } = ctx;

  await recordEvent(sessionId, 'LLM_REQUEST', {
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
    // Anthropic and Gemini streams are translated into OpenAI chunks, so their
    // tool calls go through the same gate as OpenAI's.
    let translator: StreamTranslator | undefined;

    if (provider === 'anthropic') {
      targetUrl = anthropicUrl();
      headers = buildAnthropicHeaders(auth.key);
      requestBody = JSON.stringify(translateToAnthropic(body));
      translator = createAnthropicStreamTranslator();
    } else if (provider === 'gemini') {
      targetUrl = geminiUrl(model, true);
      headers = buildGeminiHeaders(auth.key);
      requestBody = JSON.stringify(translateToGemini(body));
      translator = createGeminiStreamTranslator(model);
    } else {
      targetUrl = openAIUrl('/chat/completions');
      headers = buildOpenAIHeaders(auth.key);
      requestBody = JSON.stringify(body);
    }

    proxyStream(targetUrl, 'POST', headers, requestBody, res, async (result) => {
      const duration_ms = Date.now() - startTime;
      await recordEvent(sessionId, 'LLM_RESPONSE', null, {
        content: result.assembled,
        finish_reason: result.finish_reason,
        ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}),
        ...(result.withheld ? { withheld_tool_calls: true } : {}),
        ...(result.partial ? { partial: true } : {}),
      }, {
        model,
        duration_ms,
        token_usage: result.usage,
        timestamp: new Date().toISOString(),
      });
      trackRequest(model, result.usage?.total_tokens ?? 0, duration_ms);
    }, (calls) => gateToolCalls(sessionId, agentId, calls), translator);

    return;
  }

  return handleNonStream(req, res, body, model, provider, auth.key, sessionId, agentId, startTime);
});

async function handleNonStream(
  _req: Request,
  res: Response,
  body: OpenAIRequest,
  model: string,
  provider: string,
  apiKey: string,
  sessionId: string,
  agentId: string,
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
    targetUrl = geminiUrl(model);
    headers = buildGeminiHeaders(apiKey);
    requestBody = JSON.stringify(translateToGemini(body));
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
      req.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`upstream sent nothing for ${UPSTREAM_IDLE_TIMEOUT_MS} ms`));
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
      await recordEvent(sessionId, 'ERROR', { status: responseData.statusCode }, responseJson, {
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

    // The trace records what the model proposed; the client gets the enforced response.
    await recordEvent(sessionId, 'LLM_RESPONSE', null, finalResponse, {
      model,
      duration_ms,
      token_usage: usage,
      timestamp: new Date().toISOString(),
    });

    const calls = toolCallsInResponse(finalResponse);
    const note = calls.length > 0 ? await gateToolCalls(sessionId, agentId, calls) : null;

    trackRequest(model, usage?.total_tokens ?? 0, duration_ms);
    res.json(note ? withholdToolCalls(finalResponse, note) : finalResponse);
  } catch (err) {
    await recordEvent(sessionId, 'ERROR', null, { message: (err as Error).message }, {
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
  const auth = resolveAuth(req, provider, req.app.locals.security);

  if (!auth.key) {
    return res.status(401).json({ error: { message: 'No API key' } });
  }

  const sessionHeader = req.headers['x-interveil-session-id'] as string | undefined;
  const dateStr = new Date().toISOString().split('T')[0];
  const sessionId = sessionHeader ?? `ide-proxy-${dateStr}`;
  await ensureSession(sessionId, { name: `Gateway — ${model}`, metadata: { source: 'gateway', badge: 'GATEWAY' } });
  await recordEvent(sessionId, 'CUSTOM', body, null, { model });

  return res.status(501).json({ error: { message: 'Interveil Gateway: Embeddings endpoint is not implemented.' } });
});

export default router;
