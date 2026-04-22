// ========== KEMLLM Model Registry ==========
// All slugs verified against the live Replicate model catalog by scraping
// https://replicate.com/<owner> pages. Every version listed is a real
// Replicate model that can be invoked via the prediction API.
//
// Updated 2026-04-22.
'use strict';

const PROVIDER_COLORS = {
  anthropic: '#d97757',
  openai:    '#10a37f',
  google:    '#4a9eff',
  xai:       '#fff',
  meta:      '#0467df',
  mistral:   '#fa520f',
  deepseek:  '#4d6bff',
  qwen:      '#a855f7',
  moonshot:  '#ffb347',
  custom:    '#a78bfa',
};

// Every chat-capable model. Three categories:
//
// 1. Models with `replicateId` only → available via Replicate (always
//    visible in the dropdown if a Replicate key is set).
//
// 2. Models with both `replicateId` AND `apiId` → available via
//    Replicate OR via the direct provider API (always visible).
//
// 3. Models with `apiId` only and `requiresDirectKey: true` → ONLY
//    available through the direct provider API. Hidden from the dropdown
//    unless the user has the matching provider key set in Settings.
//    These are typically models that haven't been mirrored to Replicate
//    yet (Claude Sonnet 4.6, future Gemini/Grok versions, etc).
//
// apiId values are exact strings the direct provider expects — no
// '-latest' suffixes.
const CHAT_MODELS = [
  // ===== Anthropic =====
  // Direct-API only (no Replicate mirror yet)
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', apiId: 'claude-sonnet-4-6', requiresDirectKey: true },
  { id: 'claude-haiku-4-6',  name: 'Claude Haiku 4.6',  provider: 'anthropic', apiId: 'claude-haiku-4-6',  requiresDirectKey: true },
  // On Replicate AND direct API
  { id: 'claude-opus-4.7',   name: 'Claude Opus 4.7',   provider: 'anthropic', replicateId: 'anthropic/claude-opus-4.7',   apiId: 'claude-opus-4-7' },
  { id: 'claude-opus-4.6',   name: 'Claude Opus 4.6',   provider: 'anthropic', replicateId: 'anthropic/claude-opus-4.6',   apiId: 'claude-opus-4-6' },
  { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', provider: 'anthropic', replicateId: 'anthropic/claude-4.5-sonnet', apiId: 'claude-sonnet-4-5' },
  { id: 'claude-4.5-haiku',  name: 'Claude 4.5 Haiku',  provider: 'anthropic', replicateId: 'anthropic/claude-4.5-haiku',  apiId: 'claude-haiku-4-5' },
  { id: 'claude-4-sonnet',   name: 'Claude 4 Sonnet',   provider: 'anthropic', replicateId: 'anthropic/claude-4-sonnet',   apiId: 'claude-sonnet-4-0' },
  { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic', replicateId: 'anthropic/claude-3.7-sonnet', apiId: 'claude-3-7-sonnet-20250219' },
  { id: 'claude-3.5-haiku',  name: 'Claude 3.5 Haiku',  provider: 'anthropic', replicateId: 'anthropic/claude-3.5-haiku',  apiId: 'claude-3-5-haiku-20241022' },

  // ===== OpenAI =====
  { id: 'gpt-5.4',          name: 'GPT-5.4',          provider: 'openai', replicateId: 'openai/gpt-5.4',          apiId: 'gpt-5.4' },
  { id: 'gpt-5.2',          name: 'GPT-5.2',          provider: 'openai', replicateId: 'openai/gpt-5.2',          apiId: 'gpt-5.2' },
  { id: 'gpt-5.1',          name: 'GPT-5.1',          provider: 'openai', replicateId: 'openai/gpt-5.1',          apiId: 'gpt-5.1' },
  { id: 'gpt-5-pro',        name: 'GPT-5 Pro',        provider: 'openai', replicateId: 'openai/gpt-5-pro',        apiId: 'gpt-5-pro' },
  { id: 'gpt-5',            name: 'GPT-5',            provider: 'openai', replicateId: 'openai/gpt-5',            apiId: 'gpt-5' },
  { id: 'gpt-5-mini',       name: 'GPT-5 Mini',       provider: 'openai', replicateId: 'openai/gpt-5-mini',       apiId: 'gpt-5-mini' },
  { id: 'gpt-5-nano',       name: 'GPT-5 Nano',       provider: 'openai', replicateId: 'openai/gpt-5-nano',       apiId: 'gpt-5-nano' },
  { id: 'gpt-5-structured', name: 'GPT-5 Structured', provider: 'openai', replicateId: 'openai/gpt-5-structured' },
  { id: 'gpt-4.1',          name: 'GPT-4.1',          provider: 'openai', replicateId: 'openai/gpt-4.1',          apiId: 'gpt-4.1' },
  { id: 'gpt-4.1-mini',     name: 'GPT-4.1 Mini',     provider: 'openai', replicateId: 'openai/gpt-4.1-mini',     apiId: 'gpt-4.1-mini' },
  { id: 'gpt-4.1-nano',     name: 'GPT-4.1 Nano',     provider: 'openai', replicateId: 'openai/gpt-4.1-nano',     apiId: 'gpt-4.1-nano' },
  { id: 'gpt-4o',           name: 'GPT-4o',           provider: 'openai', replicateId: 'openai/gpt-4o',           apiId: 'gpt-4o' },
  { id: 'gpt-4o-mini',      name: 'GPT-4o Mini',      provider: 'openai', replicateId: 'openai/gpt-4o-mini',      apiId: 'gpt-4o-mini' },
  { id: 'o1',               name: 'o1',               provider: 'openai', replicateId: 'openai/o1',               apiId: 'o1' },
  { id: 'o1-mini',          name: 'o1 Mini',          provider: 'openai', replicateId: 'openai/o1-mini',          apiId: 'o1-mini' },
  { id: 'o4-mini',          name: 'o4 Mini',          provider: 'openai', replicateId: 'openai/o4-mini',          apiId: 'o4-mini' },
  { id: 'gpt-oss-120b',     name: 'GPT OSS 120B',     provider: 'openai', replicateId: 'openai/gpt-oss-120b' },
  { id: 'gpt-oss-20b',      name: 'GPT OSS 20B',      provider: 'openai', replicateId: 'openai/gpt-oss-20b' },

  // ===== Google =====
  { id: 'gemini-3.1-pro',   name: 'Gemini 3.1 Pro',   provider: 'google', replicateId: 'google/gemini-3.1-pro',   apiId: 'gemini-3.1-pro-preview' },
  { id: 'gemini-3-pro',     name: 'Gemini 3 Pro',     provider: 'google', replicateId: 'google/gemini-3-pro',     apiId: 'gemini-3-pro' },
  { id: 'gemini-3-flash',   name: 'Gemini 3 Flash',   provider: 'google', replicateId: 'google/gemini-3-flash',   apiId: 'gemini-3-flash-preview' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', replicateId: 'google/gemini-2.5-flash', apiId: 'gemini-2.5-flash' },

  // ===== xAI (Grok) =====
  // Direct-API only (no Replicate mirror)
  { id: 'grok-4-fast',           name: 'Grok 4 Fast',           provider: 'xai', apiId: 'grok-4-fast', requiresDirectKey: true },
  { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning', provider: 'xai', apiId: 'grok-4-fast-reasoning', requiresDirectKey: true },
  { id: 'grok-3',                name: 'Grok 3',                provider: 'xai', apiId: 'grok-3', requiresDirectKey: true },
  { id: 'grok-3-mini',           name: 'Grok 3 Mini',           provider: 'xai', apiId: 'grok-3-mini', requiresDirectKey: true },
  { id: 'grok-3-fast',           name: 'Grok 3 Fast',           provider: 'xai', apiId: 'grok-3-fast', requiresDirectKey: true },
  { id: 'grok-2',                name: 'Grok 2',                provider: 'xai', apiId: 'grok-2-1212', requiresDirectKey: true },
  { id: 'grok-2-vision',         name: 'Grok 2 Vision',         provider: 'xai', apiId: 'grok-2-vision-1212', requiresDirectKey: true },
  { id: 'grok-beta',             name: 'Grok Beta',             provider: 'xai', apiId: 'grok-beta', requiresDirectKey: true },
  // On Replicate
  { id: 'grok-4',                name: 'Grok 4',                provider: 'xai', replicateId: 'xai/grok-4', apiId: 'grok-4' },

  // ===== Meta (Llama) =====
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'meta', replicateId: 'meta/llama-4-maverick-instruct' },
  { id: 'llama-4-scout',    name: 'Llama 4 Scout',    provider: 'meta', replicateId: 'meta/llama-4-scout-instruct' },
  { id: 'llama-3-70b',      name: 'Llama 3 70B',      provider: 'meta', replicateId: 'meta/meta-llama-3-70b-instruct' },
  { id: 'llama-3-8b',       name: 'Llama 3 8B',       provider: 'meta', replicateId: 'meta/meta-llama-3-8b-instruct' },
  { id: 'llama-2-70b',      name: 'Llama 2 70B',      provider: 'meta', replicateId: 'meta/llama-2-70b-chat' },
  { id: 'llama-2-13b',      name: 'Llama 2 13B',      provider: 'meta', replicateId: 'meta/llama-2-13b-chat' },
  { id: 'codellama-70b',    name: 'CodeLlama 70B',    provider: 'meta', replicateId: 'meta/codellama-70b-instruct' },
  { id: 'codellama-34b',    name: 'CodeLlama 34B',    provider: 'meta', replicateId: 'meta/codellama-34b-instruct' },

  // ===== Mistral =====
  { id: 'mistral-7b',  name: 'Mistral 7B Instruct', provider: 'mistral', replicateId: 'mistralai/mistral-7b-instruct-v0.1' },
  { id: 'voxtral-3b',  name: 'Voxtral Mini 3B',     provider: 'mistral', replicateId: 'mistralai/voxtral-mini-3b' },

  // ===== DeepSeek =====
  { id: 'deepseek-r1',   name: 'DeepSeek R1',   provider: 'deepseek', replicateId: 'deepseek-ai/deepseek-r1' },
  { id: 'deepseek-v3.1', name: 'DeepSeek V3.1', provider: 'deepseek', replicateId: 'deepseek-ai/deepseek-v3.1' },
  { id: 'deepseek-v3',   name: 'DeepSeek V3',   provider: 'deepseek', replicateId: 'deepseek-ai/deepseek-v3' },
  // Note: deepseek-67b-base, codellama-* base models, llama-2-* base models,
  // mistral-7b-v0.1, etc are intentionally NOT in this list. They are
  // base/non-instruct models that don't accept chat-formatted prompts and
  // some require version pinning that breaks the universal predict path.

  // ===== Qwen (Alibaba) =====
  { id: 'qwen3-235b', name: 'Qwen 3 235B', provider: 'qwen', replicateId: 'qwen/qwen3-235b-a22b-instruct-2507' },

  // ===== Moonshot (Kimi) =====
  { id: 'kimi-k2.5',       name: 'Kimi K2.5',          provider: 'moonshot', replicateId: 'moonshotai/kimi-k2.5' },
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking',  provider: 'moonshot', replicateId: 'moonshotai/kimi-k2-thinking' },

  // ===== Google DeepMind (open-weight Gemma family) =====
  { id: 'gemma-3-27b', name: 'Gemma 3 27B IT', provider: 'google', replicateId: 'google-deepmind/gemma-3-27b-it' },
  { id: 'gemma-3-12b', name: 'Gemma 3 12B IT', provider: 'google', replicateId: 'google-deepmind/gemma-3-12b-it' },
  { id: 'gemma-3-4b',  name: 'Gemma 3 4B IT',  provider: 'google', replicateId: 'google-deepmind/gemma-3-4b-it' },
  { id: 'gemma2-27b',  name: 'Gemma 2 27B IT', provider: 'google', replicateId: 'google-deepmind/gemma2-27b-it' },
  { id: 'gemma2-9b',   name: 'Gemma 2 9B IT',  provider: 'google', replicateId: 'google-deepmind/gemma2-9b-it' },
  { id: 'gemma-2-2b',  name: 'Gemma 2 2B IT',  provider: 'google', replicateId: 'google-deepmind/gemma-2-2b-it' },

  // ===== 01.AI (Yi) =====
  { id: 'yi-34b-chat', name: 'Yi 34B Chat', provider: 'mistral', replicateId: '01-ai/yi-34b-chat' },
  { id: 'yi-6b-chat',  name: 'Yi 6B Chat',  provider: 'mistral', replicateId: '01-ai/yi-6b-chat' },
];

// Image generation models on Replicate.
const IMAGE_MODELS = [
  // Black Forest Labs (FLUX)
  { id: 'flux-2-pro',          name: 'FLUX 2 Pro',          replicateId: 'black-forest-labs/flux-2-pro' },
  { id: 'flux-2-max',          name: 'FLUX 2 Max',          replicateId: 'black-forest-labs/flux-2-max' },
  { id: 'flux-2-flex',         name: 'FLUX 2 Flex',         replicateId: 'black-forest-labs/flux-2-flex' },
  { id: 'flux-2-dev',          name: 'FLUX 2 Dev',          replicateId: 'black-forest-labs/flux-2-dev' },
  { id: 'flux-1.1-pro-ultra',  name: 'FLUX 1.1 Pro Ultra',  replicateId: 'black-forest-labs/flux-1.1-pro-ultra' },
  { id: 'flux-1.1-pro',        name: 'FLUX 1.1 Pro',        replicateId: 'black-forest-labs/flux-1.1-pro' },
  { id: 'flux-dev',            name: 'FLUX Dev',            replicateId: 'black-forest-labs/flux-dev' },
  { id: 'flux-fill-pro',       name: 'FLUX Fill Pro',       replicateId: 'black-forest-labs/flux-fill-pro' },
  { id: 'flux-fill-dev',       name: 'FLUX Fill Dev',       replicateId: 'black-forest-labs/flux-fill-dev' },
  { id: 'flux-kontext-pro',    name: 'FLUX Kontext Pro',    replicateId: 'black-forest-labs/flux-kontext-pro' },
  { id: 'flux-kontext-max',    name: 'FLUX Kontext Max',    replicateId: 'black-forest-labs/flux-kontext-max' },
  { id: 'flux-kontext-dev',    name: 'FLUX Kontext Dev',    replicateId: 'black-forest-labs/flux-kontext-dev' },
  { id: 'flux-2-klein-9b',     name: 'FLUX 2 Klein 9B',     replicateId: 'black-forest-labs/flux-2-klein-9b' },
  { id: 'flux-2-klein-4b',     name: 'FLUX 2 Klein 4B',     replicateId: 'black-forest-labs/flux-2-klein-4b' },
  // Google
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', replicateId: 'google/nano-banana-pro' },
  { id: 'nano-banana-2',   name: 'Nano Banana 2',   replicateId: 'google/nano-banana-2' },
  { id: 'nano-banana',     name: 'Nano Banana',     replicateId: 'google/nano-banana' },
  { id: 'imagen-4-ultra',  name: 'Imagen 4 Ultra',  replicateId: 'google/imagen-4-ultra' },
  { id: 'imagen-4',        name: 'Imagen 4',        replicateId: 'google/imagen-4' },
  { id: 'imagen-4-fast',   name: 'Imagen 4 Fast',   replicateId: 'google/imagen-4-fast' },
  { id: 'imagen-3',        name: 'Imagen 3',        replicateId: 'google/imagen-3' },
  { id: 'imagen-3-fast',   name: 'Imagen 3 Fast',   replicateId: 'google/imagen-3-fast' },
  { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image', replicateId: 'google/gemini-2.5-flash-image' },
  // OpenAI
  { id: 'gpt-image-2',     name: 'GPT Image 2',     replicateId: 'openai/gpt-image-2' },
  { id: 'gpt-image-1.5',   name: 'GPT Image 1.5',   replicateId: 'openai/gpt-image-1.5' },
  { id: 'gpt-image-1',     name: 'GPT Image 1',     replicateId: 'openai/gpt-image-1' },
  { id: 'gpt-image-1-mini',name: 'GPT Image 1 Mini',replicateId: 'openai/gpt-image-1-mini' },
  { id: 'dall-e-3',        name: 'DALL-E 3',        replicateId: 'openai/dall-e-3' },
  { id: 'dall-e-2',        name: 'DALL-E 2',        replicateId: 'openai/dall-e-2' },
  // Stability AI
  { id: 'sd-3.5-large',       name: 'SD 3.5 Large',       replicateId: 'stability-ai/stable-diffusion-3.5-large' },
  { id: 'sd-3.5-large-turbo', name: 'SD 3.5 Large Turbo', replicateId: 'stability-ai/stable-diffusion-3.5-large-turbo' },
  { id: 'sd-3.5-medium',      name: 'SD 3.5 Medium',      replicateId: 'stability-ai/stable-diffusion-3.5-medium' },
  { id: 'sd-3',               name: 'SD 3',               replicateId: 'stability-ai/stable-diffusion-3' },
  { id: 'sdxl',               name: 'SDXL',               replicateId: 'stability-ai/sdxl' },
  // Ideogram
  { id: 'ideogram-v3-quality',  name: 'Ideogram V3 Quality',  replicateId: 'ideogram-ai/ideogram-v3-quality' },
  { id: 'ideogram-v3-balanced', name: 'Ideogram V3 Balanced', replicateId: 'ideogram-ai/ideogram-v3-balanced' },
  { id: 'ideogram-v3-turbo',    name: 'Ideogram V3 Turbo',    replicateId: 'ideogram-ai/ideogram-v3-turbo' },
  { id: 'ideogram-v2',          name: 'Ideogram V2',          replicateId: 'ideogram-ai/ideogram-v2' },
  { id: 'ideogram-v2-turbo',    name: 'Ideogram V2 Turbo',    replicateId: 'ideogram-ai/ideogram-v2-turbo' },
  { id: 'ideogram-v2a',         name: 'Ideogram V2a',         replicateId: 'ideogram-ai/ideogram-v2a' },
  { id: 'ideogram-v2a-turbo',   name: 'Ideogram V2a Turbo',   replicateId: 'ideogram-ai/ideogram-v2a-turbo' },
  { id: 'ideogram-character',   name: 'Ideogram Character',   replicateId: 'ideogram-ai/ideogram-character' },
  // Recraft
  { id: 'recraft-v4-pro',     name: 'Recraft V4 Pro',     replicateId: 'recraft-ai/recraft-v4-pro' },
  { id: 'recraft-v4',         name: 'Recraft V4',         replicateId: 'recraft-ai/recraft-v4' },
  { id: 'recraft-v4-pro-svg', name: 'Recraft V4 Pro SVG', replicateId: 'recraft-ai/recraft-v4-pro-svg' },
  { id: 'recraft-v4-svg',     name: 'Recraft V4 SVG',     replicateId: 'recraft-ai/recraft-v4-svg' },
  // ByteDance (Seedream)
  { id: 'seedream-5-lite', name: 'Seedream 5.0 Lite', replicateId: 'bytedance/seedream-5-lite' },
  { id: 'seedream-4.5',   name: 'Seedream 4.5',      replicateId: 'bytedance/seedream-4.5' },
  { id: 'seedream-4',     name: 'Seedream 4',         replicateId: 'bytedance/seedream-4' },
  // Qwen Image
  { id: 'qwen-image-2-pro', name: 'Qwen Image 2 Pro', replicateId: 'qwen/qwen-image-2-pro' },
  { id: 'qwen-image-2',     name: 'Qwen Image 2',     replicateId: 'qwen/qwen-image-2' },
  // Luma
  { id: 'photon',       name: 'Luma Photon',       replicateId: 'luma/photon' },
  { id: 'photon-flash', name: 'Luma Photon Flash', replicateId: 'luma/photon-flash' },
  // Wan
  { id: 'wan-2.7-image-pro', name: 'Wan 2.7 Image Pro', replicateId: 'wan-video/wan-2.7-image-pro' },
  { id: 'wan-2.7-image',     name: 'Wan 2.7 Image',     replicateId: 'wan-video/wan-2.7-image' },
  // Runway
  { id: 'gen4-image',       name: 'Runway Gen-4 Image',       replicateId: 'runwayml/gen4-image' },
  { id: 'gen4-image-turbo', name: 'Runway Gen-4 Image Turbo', replicateId: 'runwayml/gen4-image-turbo' },
  // Minimax
  { id: 'minimax-image-01', name: 'Minimax Image 01', replicateId: 'minimax/image-01' },
  // xAI
  { id: 'grok-imagine-image', name: 'Grok Imagine', replicateId: 'xai/grok-imagine-image' },
];

// Video generation models on Replicate.
const VIDEO_MODELS = [
  // Google Veo
  { id: 'veo-3.1',      name: 'Veo 3.1',       replicateId: 'google/veo-3.1' },
  { id: 'veo-3.1-fast', name: 'Veo 3.1 Fast',  replicateId: 'google/veo-3.1-fast' },
  { id: 'veo-3.1-lite', name: 'Veo 3.1 Lite',  replicateId: 'google/veo-3.1-lite' },
  { id: 'veo-3',        name: 'Veo 3',         replicateId: 'google/veo-3' },
  { id: 'veo-3-fast',   name: 'Veo 3 Fast',    replicateId: 'google/veo-3-fast' },
  { id: 'veo-2',        name: 'Veo 2',         replicateId: 'google/veo-2' },
  // Runway Gen-4
  { id: 'gen-4.5',     name: 'Runway Gen-4.5',     replicateId: 'runwayml/gen-4.5' },
  { id: 'gen4-aleph',  name: 'Runway Gen-4 Aleph', replicateId: 'runwayml/gen4-aleph' },
  { id: 'gen4-turbo',  name: 'Runway Gen-4 Turbo', replicateId: 'runwayml/gen4-turbo' },
  // OpenAI Sora
  { id: 'sora-2-pro', name: 'Sora 2 Pro', replicateId: 'openai/sora-2-pro' },
  { id: 'sora-2',     name: 'Sora 2',     replicateId: 'openai/sora-2' },
  // Minimax Hailuo
  { id: 'hailuo-2.3',      name: 'Minimax Hailuo 2.3',      replicateId: 'minimax/hailuo-2.3' },
  { id: 'hailuo-2.3-fast', name: 'Minimax Hailuo 2.3 Fast', replicateId: 'minimax/hailuo-2.3-fast' },
  { id: 'hailuo-02',       name: 'Minimax Hailuo 02',       replicateId: 'minimax/hailuo-02' },
  { id: 'hailuo-02-fast',  name: 'Minimax Hailuo 02 Fast', replicateId: 'minimax/hailuo-02-fast' },
  { id: 'minimax-video-01',name: 'Minimax Video 01',        replicateId: 'minimax/video-01' },
  // ByteDance (Seedance)
  { id: 'seedance-2.0',         name: 'Seedance 2.0',         replicateId: 'bytedance/seedance-2.0' },
  { id: 'seedance-2.0-fast',    name: 'Seedance 2.0 Fast',    replicateId: 'bytedance/seedance-2.0-fast' },
  { id: 'seedance-1.5-pro',     name: 'Seedance 1.5 Pro',     replicateId: 'bytedance/seedance-1.5-pro' },
  { id: 'seedance-1-pro',       name: 'Seedance 1 Pro',       replicateId: 'bytedance/seedance-1-pro' },
  { id: 'seedance-1-pro-fast',  name: 'Seedance 1 Pro Fast',  replicateId: 'bytedance/seedance-1-pro-fast' },
  { id: 'seedance-1-lite',      name: 'Seedance 1 Lite',      replicateId: 'bytedance/seedance-1-lite' },
  // Lightricks LTX
  { id: 'ltx-2.3-pro',    name: 'LTX 2.3 Pro',    replicateId: 'lightricks/ltx-2.3-pro' },
  { id: 'ltx-2.3-fast',   name: 'LTX 2.3 Fast',   replicateId: 'lightricks/ltx-2.3-fast' },
  { id: 'ltx-2-pro',      name: 'LTX 2 Pro',      replicateId: 'lightricks/ltx-2-pro' },
  { id: 'ltx-2-fast',     name: 'LTX 2 Fast',     replicateId: 'lightricks/ltx-2-fast' },
  { id: 'ltx-2-distilled',name: 'LTX 2 Distilled', replicateId: 'lightricks/ltx-2-distilled' },
  { id: 'ltx-2-retake',   name: 'LTX 2 Retake',   replicateId: 'lightricks/ltx-2-retake' },
  { id: 'ltx-video',      name: 'LTX Video',       replicateId: 'lightricks/ltx-video' },
  // Wan Video
  { id: 'wan-2.7-t2v',       name: 'Wan 2.7 T2V',       replicateId: 'wan-video/wan-2.7-t2v' },
  { id: 'wan-2.7-i2v',       name: 'Wan 2.7 I2V',       replicateId: 'wan-video/wan-2.7-i2v' },
  { id: 'wan-2.7-r2v',       name: 'Wan 2.7 R2V',       replicateId: 'wan-video/wan-2.7-r2v' },
  { id: 'wan-2.7-videoedit', name: 'Wan 2.7 VideoEdit',  replicateId: 'wan-video/wan-2.7-videoedit' },
  // xAI Grok video
  { id: 'grok-imagine-video',           name: 'Grok Imagine Video',     replicateId: 'xai/grok-imagine-video' },
  { id: 'grok-imagine-r2v',             name: 'Grok Imagine R2V',       replicateId: 'xai/grok-imagine-r2v' },
  { id: 'grok-imagine-video-extension', name: 'Grok Imagine Video Ext', replicateId: 'xai/grok-imagine-video-extension' },
  // Luma Ray
  { id: 'ray-2-720p',       name: 'Luma Ray 2 720p',       replicateId: 'luma/ray-2-720p' },
  { id: 'ray-2-540p',       name: 'Luma Ray 2 540p',       replicateId: 'luma/ray-2-540p' },
  { id: 'ray-flash-2-720p', name: 'Luma Ray Flash 2 720p', replicateId: 'luma/ray-flash-2-720p' },
  { id: 'ray-flash-2-540p', name: 'Luma Ray Flash 2 540p', replicateId: 'luma/ray-flash-2-540p' },
  { id: 'luma-modify-video', name: 'Luma Modify Video',    replicateId: 'luma/modify-video' },
  // PixVerse
  { id: 'pixverse-v4', name: 'PixVerse V4', replicateId: 'pixverse/pixverse-v4' },
  // Vidu
  { id: 'vidu-q3-pro',   name: 'Vidu Q3 Pro',   replicateId: 'vidu/q3-pro' },
  { id: 'vidu-q3-turbo', name: 'Vidu Q3 Turbo', replicateId: 'vidu/q3-turbo' },
  // Kuaishou Kling — every model owned by the kwaivgi account on
  // Replicate (verified live from https://replicate.com/kwaivgi).
  // === v3 family (newest) ===
  { id: 'kling-v3-omni-video',     name: 'Kling v3 Omni',           replicateId: 'kwaivgi/kling-v3-omni-video' },
  { id: 'kling-v3-video',          name: 'Kling v3 Video',          replicateId: 'kwaivgi/kling-v3-video' },
  { id: 'kling-v3-motion-control', name: 'Kling v3 Motion Control', replicateId: 'kwaivgi/kling-v3-motion-control' },
  // === v2.6 ===
  { id: 'kling-v2.6',                 name: 'Kling v2.6 Pro',           replicateId: 'kwaivgi/kling-v2.6' },
  { id: 'kling-v2.6-motion-control',  name: 'Kling v2.6 Motion Control', replicateId: 'kwaivgi/kling-v2.6-motion-control' },
  // === v2.5 ===
  { id: 'kling-v2.5-turbo-pro',    name: 'Kling v2.5 Turbo Pro',    replicateId: 'kwaivgi/kling-v2.5-turbo-pro' },
  // === v2.1 / v2.0 ===
  { id: 'kling-v2.1-master',       name: 'Kling v2.1 Master',       replicateId: 'kwaivgi/kling-v2.1-master' },
  { id: 'kling-v2.1',              name: 'Kling v2.1',              replicateId: 'kwaivgi/kling-v2.1' },
  { id: 'kling-v2.0',              name: 'Kling v2.0',              replicateId: 'kwaivgi/kling-v2.0' },
  // === v1.x ===
  { id: 'kling-v1.6-pro',          name: 'Kling v1.6 Pro',          replicateId: 'kwaivgi/kling-v1.6-pro' },
  { id: 'kling-v1.6-standard',     name: 'Kling v1.6 Standard',     replicateId: 'kwaivgi/kling-v1.6-standard' },
  { id: 'kling-v1.5-pro',          name: 'Kling v1.5 Pro',          replicateId: 'kwaivgi/kling-v1.5-pro' },
  { id: 'kling-v1.5-standard',     name: 'Kling v1.5 Standard',     replicateId: 'kwaivgi/kling-v1.5-standard' },
  // === Special-purpose ===
  { id: 'kling-o1',                name: 'Kling O1 (video edit)',   replicateId: 'kwaivgi/kling-o1' },
  { id: 'kling-avatar-v2',         name: 'Kling Avatar v2',         replicateId: 'kwaivgi/kling-avatar-v2' },
  { id: 'kling-lip-sync',          name: 'Kling Lip Sync',          replicateId: 'kwaivgi/kling-lip-sync' },
];

let selectedChat  = 'claude-4.5-sonnet';
let selectedImage = 'nano-banana-pro';
let selectedVideo = 'veo-3.1';

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
  if (typeof renderModelDropdowns === 'function') renderModelDropdowns();
}
