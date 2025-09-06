import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

interface ProviderResult {
  ok: boolean;
  detail: string;
}

type OpenAIModelsResponse = { data?: unknown[] } | Record<string, unknown>;
type AnthropicModelsResponse = { data?: unknown[] } | Record<string, unknown>;
type GeminiModelsResponse = { models?: unknown[] } | Record<string, unknown>;

function getArrayLen(obj: unknown, key: string): number {
  if (obj && typeof obj === 'object') {
    const val = (obj as Record<string, unknown>)[key];
    if (Array.isArray(val)) return val.length;
  }
  return 0;
}

async function verifyOpenAI(): Promise<ProviderResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, detail: 'Missing OPENAI_API_KEY' };
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (r.status === 200) {
      const j = (await r.json()) as OpenAIModelsResponse;
      return {
        ok: true,
        detail: `Listed ${getArrayLen(j, 'data')} models`,
      };
    }
    return { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}

async function verifyAnthropic(): Promise<ProviderResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, detail: 'Missing ANTHROPIC_API_KEY' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (r.status === 200) {
      const j = (await r.json()) as AnthropicModelsResponse;
      return {
        ok: true,
        detail: `Listed ${getArrayLen(j, 'data')} models`,
      };
    }
    return { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}

async function verifyGemini(): Promise<ProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, detail: 'Missing GEMINI_API_KEY' };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    );
    if (r.status === 200) {
      const j = (await r.json()) as GeminiModelsResponse;
      return {
        ok: true,
        detail: `Listed ${getArrayLen(j, 'models')} models`,
      };
    }
    return { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}

async function main(): Promise<void> {
  await NestFactory.createApplicationContext(AppModule, { logger: false });
  const results: Record<string, ProviderResult> = {
    openai: await verifyOpenAI(),
    anthropic: await verifyAnthropic(),
    gemini: await verifyGemini(),
  };
  console.log(JSON.stringify(results, null, 2));
  process.exit(Object.values(results).some((r) => !r.ok) ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected verification error', err);
  process.exit(1);
});
