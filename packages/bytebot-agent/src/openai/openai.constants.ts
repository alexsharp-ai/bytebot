import { BytebotAgentModel } from 'src/agent/agent.types';

// NOTE: Removed date-suffixed model names which were likely invalid and caused failures.
// Use canonical model identifiers that the Responses API typically exposes.
export const OPENAI_MODELS: BytebotAgentModel[] = [
  {
    provider: 'openai',
    name: 'gpt-4.1',
    title: 'GPT-4.1',
    contextWindow: 1_000_000,
  },
  {
    provider: 'openai',
    name: 'gpt-4.1-mini',
    title: 'GPT-4.1 Mini',
    contextWindow: 512_000,
  },
  // Remove or gate experimental reasoning model until access is confirmed
  // {
  //   provider: 'openai',
  //   name: 'o3-mini',
  //   title: 'o3 Mini (Reasoning)',
  //   contextWindow: 200_000,
  // },
];

export const DEFAULT_MODEL = OPENAI_MODELS[0];
