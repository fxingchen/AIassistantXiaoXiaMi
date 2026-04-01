/**
 * 多模型提供商配置
 * 支持：SiliconFlow、DeepSeek、通义千问、智谱GLM等
 */

const PROVIDERS = {
  siliconflow: {
    name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn',
    models: [
      { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3-235B 🔥', type: 'chat' },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3-32B', type: 'chat' },
      { id: 'deepseek-ai/DeepSeek-R1-0528', name: 'DeepSeek-R1-0528', type: 'chat' },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', type: 'chat' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', type: 'chat' },
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct', name: 'Qwen2.5-VL-72B', type: 'chat' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', type: 'chat' },
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v1/chat/completions'
  },

  deepseek: {
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', type: 'chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner R1', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/chat/completions'
  },

  qwen: {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode',
    models: [
      { id: 'qwen-turbo', name: 'Qwen Turbo', type: 'chat' },
      { id: 'qwen-plus', name: 'Qwen Plus', type: 'chat' },
      { id: 'qwen-max', name: 'Qwen Max', type: 'chat' },
      { id: 'qwen-max-longcontext', name: 'Qwen Max 长上下文', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v1/chat/completions'
  },

  zhipu: {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas',
    models: [
      { id: 'glm-4', name: 'GLM-4', type: 'chat' },
      { id: 'glm-4-air', name: 'GLM-4 Air', type: 'chat' },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', type: 'chat' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v4/chat/completions'
  },

  moonshot: {
    name: 'Moonshot Kimi',
    baseURL: 'https://api.moonshot.cn',
    models: [
      { id: 'moonshot-v1-8k', name: 'Kimi 8K', type: 'chat' },
      { id: 'moonshot-v1-32k', name: 'Kimi 32K', type: 'chat' },
      { id: 'moonshot-v1-128k', name: 'Kimi 128K', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v1/chat/completions'
  },

  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', type: 'chat' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', type: 'chat' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', type: 'chat' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v1/chat/completions'
  },

  custom: {
    name: '自定义API',
    baseURL: '',
    models: [
      { id: 'custom-model', name: '自定义模型', type: 'chat' }
    ],
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    chatPath: '/v1/chat/completions',
    customizable: true
  }
};

/**
 * 获取提供商配置
 */
function getProvider(providerId) {
  return PROVIDERS[providerId] || PROVIDERS.siliconflow;
}

/**
 * 获取所有提供商列表
 */
function getAllProviders() {
  return Object.entries(PROVIDERS).map(([id, config]) => ({
    id,
    name: config.name,
    modelCount: config.models.length
  }));
}

/**
 * 获取提供商的所有模型
 */
function getProviderModels(providerId) {
  const provider = getProvider(providerId);
  return provider.models.map(m => ({
    id: m.id,
    name: m.name,
    fullName: `${provider.name} / ${m.name}`,
    type: m.type
  }));
}

/**
 * 根据模型ID查找提供商
 */
function findProviderByModel(modelId) {
  for (const [providerId, config] of Object.entries(PROVIDERS)) {
    if (config.models.some(m => m.id === modelId)) {
      return providerId;
    }
  }
  return 'siliconflow'; // 默认
}

/**
 * 构建API请求配置
 */
function buildRequestConfig(providerId, modelId, apiKey, messages, options = {}) {
  const provider = getProvider(providerId);
  
  const config = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [provider.authHeader]: `${provider.authPrefix}${apiKey}`
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: options.stream !== false,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens,
      ...options.extra
    })
  };

  return {
    url: `${provider.baseURL}${provider.chatPath}`,
    config
  };
}

module.exports = {
  PROVIDERS,
  getProvider,
  getAllProviders,
  getProviderModels,
  findProviderByModel,
  buildRequestConfig
};
