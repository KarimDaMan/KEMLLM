// ========== KEMLLM Model Registry ==========
'use strict';

const PROVIDER_COLORS = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4a9eff',
  xai: '#fff',
  meta: '#0467df',
  mistral: '#fa520f',
  deepseek: '#4d6bff',
  custom: '#a78bfa'
};

// NOTE: Anthropic / OpenAI / Google / xAI chat models are not reliably
// available on Replicate. They need direct provider keys (Settings → API
// Keys). Only open-source models below have verified Replicate slugs.
const CHAT_MODELS = [
  // Anthropic — needs Anthropic API key
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', apiId: 'claude-sonnet-4-6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', apiId: 'claude-opus-4-6' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic', apiId: 'claude-3-7-sonnet-latest' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', apiId: 'claude-3-5-sonnet-latest' },
  { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', provider: 'anthropic', apiId: 'claude-3-5-haiku-latest' },
  // OpenAI — needs OpenAI API key
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', apiId: 'gpt-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', apiId: 'gpt-5.4-mini' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai', apiId: 'gpt-5.4-nano' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai', apiId: 'gpt-5.3-codex' },
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', apiId: 'gpt-5.2' },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', apiId: 'gpt-5' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', apiId: 'gpt-4.1' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', apiId: 'gpt-4o' },
  // Google — needs Google AI key
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google', apiId: 'gemini-3.1-pro-preview' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google', apiId: 'gemini-3-flash-preview' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google', apiId: 'gemini-3.1-flash-lite-preview' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', apiId: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', apiId: 'gemini-2.5-flash' },
  // xAI — needs xAI API key
  { id: 'grok-4.20', name: 'Grok 4.20', provider: 'xai', apiId: 'grok-4.20' },
  { id: 'grok-4-heavy', name: 'Grok 4 Heavy', provider: 'xai', apiId: 'grok-4-heavy' },
  { id: 'grok-4.1', name: 'Grok 4.1', provider: 'xai', apiId: 'grok-4.1' },
  { id: 'grok-4.1-fast', name: 'Grok 4.1 Fast', provider: 'xai', apiId: 'grok-4.1-fast' },
  { id: 'grok-4', name: 'Grok 4', provider: 'xai', apiId: 'grok-4' },
  { id: 'grok-3', name: 'Grok 3', provider: 'xai', apiId: 'grok-3' },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', provider: 'xai', apiId: 'grok-3-mini' },
  { id: 'grok-2', name: 'Grok 2', provider: 'xai', apiId: 'grok-2' },
  // Open Source via Replicate — verified real slugs
  { id: 'llama-3-70b', name: 'Llama 3 70B', provider: 'meta', replicateId: 'meta/meta-llama-3-70b-instruct' },
  { id: 'llama-3-8b', name: 'Llama 3 8B', provider: 'meta', replicateId: 'meta/meta-llama-3-8b-instruct' },
  { id: 'llama-2-70b', name: 'Llama 2 70B', provider: 'meta', replicateId: 'meta/llama-2-70b-chat' },
  { id: 'mistral-7b', name: 'Mistral 7B', provider: 'mistral', replicateId: 'mistralai/mistral-7b-instruct-v0.2' },
  { id: 'mixtral-8x7b', name: 'Mixtral 8x7B', provider: 'mistral', replicateId: 'mistralai/mixtral-8x7b-instruct-v0.1' },
  { id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek', replicateId: 'deepseek-ai/deepseek-r1' }
];

const IMAGE_MODELS = [
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', replicateId: 'google/nano-banana-pro' },
  { id: 'nano-banana-2', name: 'Nano Banana 2', replicateId: 'google/nano-banana-2' },
  { id: 'nano-banana', name: 'Nano Banana', replicateId: 'google/nano-banana' },
  { id: 'imagen-4-ultra', name: 'Imagen 4 Ultra', replicateId: 'google-deepmind/imagen-4-ultra' },
  { id: 'imagen-4', name: 'Imagen 4', replicateId: 'google-deepmind/imagen-4' },
  { id: 'imagen-4-fast', name: 'Imagen 4 Fast', replicateId: 'google-deepmind/imagen-4-fast' },
  { id: 'imagen-3', name: 'Imagen 3', replicateId: 'google-deepmind/imagen-3' },
  { id: 'gpt-image-1.5', name: 'GPT Image 1.5', replicateId: 'openai/gpt-image-1.5' },
  { id: 'gpt-image-1-mini', name: 'GPT Image 1 Mini', replicateId: 'openai/gpt-image-1-mini' },
  { id: 'dall-e-3', name: 'DALL-E 3', replicateId: 'openai/dall-e-3' },
  { id: 'dall-e-2', name: 'DALL-E 2', replicateId: 'openai/dall-e-2' },
  { id: 'sd-3.5-large', name: 'SD 3.5 Large', replicateId: 'stability-ai/stable-diffusion-3.5-large' },
  { id: 'sd-3.5-turbo', name: 'SD 3.5 Turbo', replicateId: 'stability-ai/stable-diffusion-3.5-large-turbo' },
  { id: 'sd-3-medium', name: 'SD 3 Medium', replicateId: 'stability-ai/stable-diffusion-3-medium' },
  { id: 'sdxl', name: 'SDXL', replicateId: 'stability-ai/sdxl' },
  { id: 'flux-1.1-pro-ultra', name: 'FLUX 1.1 Pro Ultra', replicateId: 'black-forest-labs/flux-1.1-pro-ultra' },
  { id: 'flux-1.1-pro', name: 'FLUX 1.1 Pro', replicateId: 'black-forest-labs/flux-1.1-pro' },
  { id: 'flux-pro', name: 'FLUX Pro', replicateId: 'black-forest-labs/flux-pro' },
  { id: 'flux-dev', name: 'FLUX Dev', replicateId: 'black-forest-labs/flux-dev' },
  { id: 'flux-schnell', name: 'FLUX Schnell', replicateId: 'black-forest-labs/flux-schnell' },
  { id: 'ideogram-v3', name: 'Ideogram V3', replicateId: 'ideogram-ai/ideogram-v3' },
  { id: 'ideogram-v2-turbo', name: 'Ideogram V2 Turbo', replicateId: 'ideogram-ai/ideogram-v2-turbo' }
];

const VIDEO_MODELS = [
  { id: 'veo-3', name: 'Veo 3', replicateId: 'google/veo-3' },
  { id: 'veo-2', name: 'Veo 2', replicateId: 'google/veo-2' },
  { id: 'gen-4-turbo', name: 'Runway Gen-4 Turbo', replicateId: 'runwayml/gen-4-turbo' },
  { id: 'gen-4', name: 'Runway Gen-4', replicateId: 'runwayml/gen-4' },
  { id: 'gen-3-alpha-turbo', name: 'Runway Gen-3 Alpha Turbo', replicateId: 'runwayml/gen-3-alpha-turbo' },
  { id: 'minimax-video-01', name: 'Minimax Video 01', replicateId: 'minimax/video-01' },
  { id: 'kling-1-6-pro', name: 'Kling 1.6 Pro', replicateId: 'klingai/kling-v1-6-pro' },
  { id: 'ltx-video', name: 'LTX Video', replicateId: 'lightricks/ltx-video' }
];

let selectedChat = 'claude-sonnet-4-6';
let selectedImage = 'flux-1.1-pro-ultra';
let selectedVideo = 'veo-3';

function getCustomModels() {
  return profileGetJSON('custom_models', []);
}
function setCustomModels(list) {
  profileSetJSON('custom_models', list);
}
function findModel(id, type) {
  const customs = getCustomModels();
  if (type === 'chat') {
    return CHAT_MODELS.find(m => m.id === id) || customs.find(m => m.type === 'chat' && m.id === id);
  }
  if (type === 'image') {
    return IMAGE_MODELS.find(m => m.id === id) || customs.find(m => m.type === 'image' && m.id === id);
  }
  if (type === 'video') {
    return VIDEO_MODELS.find(m => m.id === id) || customs.find(m => m.type === 'video' && m.id === id);
  }
}
function injectCustomModels() {
  // Re-render dropdowns to include custom models
  if (typeof renderModelDropdowns === 'function') renderModelDropdowns();
}
