// background/background.js - 后台脚本

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background收到:', request);
  
  if (request.action === 'chat') {
    const treeText = request.treeText || '';
    
    // 创建进度发送函数
    const sendProgressToContent = (message) => {
      console.log('发送进度消息:', message);
      chrome.runtime.sendMessage({ action: 'progress', message: message }).catch(err => {
        console.log('发送进度失败:', err);
      });
    };
    
    if (request.mode === 'casual') {
      casualChat(request.message).then(sendResponse);
    } else {
      // 分析模式 - 需要tabId来重新获取页面
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0].id;
        analyzeWithStrategy(treeText, request.message, tabId, sendProgressToContent).then(result => {
          sendResponse({ result: result });
        });
      });
    }
    return true;
  }
});

// 闲聊模式
async function casualChat(message) {
  const messages = [
    { role: 'system', content: '你是一个友好的AI助手 CrawlMind，可以帮助用户分析网页结构、提取数据。回答要简洁友好。' },
    { role: 'user', content: message }
  ];
  
  try {
    const result = await callLLM(messages);
    return { result: result };
  } catch (error) {
    return { result: '错误: ' + error.message };
  }
}

// 配置LLM
const LLM_CONFIG = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com'
};

// DeepSeek API 调用
async function callLLM(messages) {
  // 从storage获取API Key
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    throw new Error('请先在设置中输入API Key');
  }
  
  const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: LLM_CONFIG.model,
      messages: messages,
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `API错误: ${response.status}`);
  }
  
  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('API响应格式错误');
  }
  return data.choices[0].message.content;
}

// 分析策略：分层提取
async function analyzeWithStrategy(treeText, userRequirement, tabId, sendProgress) {
  try {
    // 同时发送到content script显示进度
    const sendProgressToPage = (msg) => {
      console.log('发送进度:', msg);
      sendProgress(msg);
      chrome.tabs.sendMessage(tabId, { action: 'progress', message: msg }).catch((err) => {
        console.log('发送失败:', err);
      });
    };
    
    // 获取完整内容树（用于数据提取）
    sendProgressToPage('📄 正在获取页面完整内容...');
    const fullTreeText = await getFullPageTree(tabId);
    if (!fullTreeText) {
      sendProgressToPage('⚠️ 获取完整内容失败，使用框架结构');
    }
    sendProgressToPage(`📄 页面结构已获取 (框架: ${treeText.length} 字符, 完整: ${fullTreeText?.length || 0} 字符)`);

    // ====== 第一步：20000字符，层级分析 ======
    sendProgressToPage('🔍 正在分析页面层级结构 (1/3)...');
    
    let messages = [
      { role: 'system', content: `你是一个网页结构分析助手。根据用户需求"${userRequirement}"，分析HTML树形结构。

请严格按照以下格式输出：
---分析开始---
[在这里详细描述你观察到的HTML结构，特别是哪些标签、class、id可能包含目标数据]

---层级判断---
{"层级路径": "如 div.product-list > ul > li", "包含的属性": "如 class='product-item' id='item-1'", "是否找到": true/false, "当前深度": 数字, "理由": "为什么选择这个层级"}` },
      { role: 'user', content: `用户需求：${userRequirement}\n\nHTML结构（只显示标签和属性，不含文本内容）：\n${treeText.substring(0, 20000)}` }
    ];
    
    sendProgressToPage('🤖 LLM正在分析层级结构...');
    sendProgressToPage('💭 思考中: 分析页面层级结构，判断最可能包含目标数据的层级路径...');
    let result = await callLLM(messages);
    sendProgressToPage('✅ 层级分析完成');
    
    // 提取并显示LLM的分析过程
    let analysisPart = result.match(/---分析开始---([\s\S]*?)---层级判断---/)?.[1]?.trim() || '';
    if (analysisPart) {
      sendProgressToPage(`📝 LLM分析过程:\n${analysisPart.substring(0, 500)}`);
    }
    
    // 解析层级深度
    let depthMatch = result.match(/"当前深度":\s*(\d+)/);
    let currentDepth = depthMatch ? parseInt(depthMatch[1]) : 0;
    
    // 无论是否找到，都进入循环验证流程
    // ====== 第二步：循环往下分析 + 验证（使用完整内容） ======
    let offset = 0;
    let found = false;
    let allResults = [];
    let loopCount = 1;
    const fullContent = fullTreeText || treeText;
    
    // 尝试从层级分析得到的路径开始
    let startLayerPath = '';
    if (result.includes('"是否找到": true') || result.includes('"是否找到":true')) {
      startLayerPath = result.match(/"层级路径":\s*"([^"]+)"/)?.[1] || '';
      if (startLayerPath) {
        sendProgressToPage(`✅ 层级分析找到目标层级: ${startLayerPath}`);
        sendProgressToPage('📥 正在提取并验证...');
        
        // 提取并验证
        let extractResult = await extractByLayer(fullContent, userRequirement, startLayerPath, sendProgressToPage);
        
        if (extractResult && extractResult.length > 10) {
          found = true;
          return extractResult;
        }
      }
    }
    
    sendProgressToPage('🔄 开始循环验证查找...');
    
    // 从上一次分析的层级位置继续
    while (offset < fullContent.length) {
      sendProgressToPage(`🔍 正在深度分析 (${loopCount})，范围: ${offset}-${offset + 20000}...`);
      
      let segment = fullContent.substring(offset, offset + 20000);
      if (!segment) break;
      
      messages[1].content = `用户需求：${userRequirement}\n\nHTML层级结构（深度${currentDepth + 1}）：\n${segment}\n\n请严格按照格式输出：\n---分析开始---\n[详细描述这个层级的结构，观察哪些标签、属性可能包含目标数据]\n\n---判断结果---\n{"是否找到": true/false, "层级路径": "如 div.class", "包含的属性": "如 id='xxx'", "理由": "为什么选择"}`;
      
      sendProgressToPage(`🤖 LLM正在分析深度${currentDepth + 1}...`);
      sendProgressToPage(`💭 思考中: 检查深度${currentDepth + 1}是否包含目标数据...`);
      result = await callLLM(messages);
      sendProgressToPage(`✅ 深度${currentDepth + 1}分析完成`);
      
      // 提取并显示LLM的分析过程
      let loopAnalysisPart = result.match(/---分析开始---([\s\S]*?)---判断结果---/)?.[1]?.trim() || '';
      if (loopAnalysisPart) {
        sendProgressToPage(`📝 LLM分析: ${loopAnalysisPart.substring(0, 300)}`);
      }
      
      // 解析并显示层级信息
      let layerPath = result.match(/"层级路径":\s*"([^"]+)"/)?.[1] || '';
      let layerAttrs = result.match(/"包含的属性":\s*"([^"]+)"/)?.[1] || '';
      if (layerPath) {
        sendProgressToPage(`📍 当前深度${currentDepth + 1}可能层级: ${layerPath}`);
        sendProgressToPage(`🏷️ 该层级属性: ${layerAttrs}`);
      }
      
      // 根据层级路径提取数据
      sendProgressToPage('📥 根据该层级提取数据...');
      let extractResult = await extractByLayer(fullContent, userRequirement, layerPath, sendProgressToPage);
      
      // 检查是否包含目标数据
      const hasTargetData2 = extractResult && extractResult.length > 10 && 
        !extractResult.includes('未找到') && !extractResult.includes('没有');
      
      if (hasTargetData2) {
        found = true;
        sendProgressToPage(`✅ 找到数据提取完成`);
        return extractResult;
      }
      
      currentDepth++;
      offset += 20000;
      loopCount++;
    }
    
    if (!found) {
      return '未找到匹配的数据，可能页面未加载完成或数据在其他位置。';
    }
    
    return result;
    
  } catch (error) {
    console.error('分析错误:', error);
    return '错误: ' + error.message;
  }
}

// 获取更详细结果
async function getDetailedResult(treeText, userRequirement, maxChars, sendProgress) {
  sendProgress(`📊 提取详细数据 (上限 ${maxChars} 字符)...`);
  
  let messages = [
    { role: 'system', content: '你是网页数据提取专家。根据用户需求提取具体数据，只输出结果不要思考过程。' },
    { role: 'user', content: `用户需求：${userRequirement}\n\nHTML：\n${treeText.substring(0, maxChars)}\n\n请提取所有匹配的完整数据。` }
  ];
  
  sendProgress('🤖 LLM正在提取详细数据...');
  sendProgress('💭 思考中: 从HTML中提取用户需要的具体数据...');
  let result = await callLLM(messages);
  sendProgress('✅ 数据提取完成');
  return result;
}

// 根据层级路径提取数据
async function extractByLayer(treeText, userRequirement, layerPath, sendProgress) {
  sendProgress(`🎯 根据层级路径 "${layerPath}" 提取数据...`);
  
  // 让LLM根据用户需求自动判断输出格式
  let formatMessages = [
    { role: 'system', content: `你是格式分析专家。根据用户的提取需求，判断最合适的输出格式标签。

用户需求示例和对应格式：
- "商品名称" → "商品"
- "评论内容" → "评论"  
- "商品价格" → "商品"
- "图片链接" → "图片"
- "文章文本" → "段落"

只输出一个最合适的标签，不要其他内容。` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n请判断输出格式标签是什么？` }
  ];
  
  let formatLabel = await callLLM(formatMessages);
  formatLabel = formatLabel.trim().replace(/[，。]/g, '');
  
  sendProgress(`📋 识别到数据类型: ${formatLabel}`);
  
  // 根据识别的格式标签构建输出格式
  let formatPrompt = `${formatLabel}1: xxx\n${formatLabel}2: xxx\n${formatLabel}3: xxx`;
  
  // 第一次提取 - 使用较多字符（比如50000）
  let firstExtractSize = 50000;
  sendProgress(`📊 第一次提取 (前${firstExtractSize}字符)...`);
  
  let extractMessages = [
    { role: 'system', content: `你是网页数据提取专家。只输出提取的数据，不要解释。\n\n重要：每个数据单独一行，不要放在同一行！\n\n输出格式示例：\n${formatPrompt}\n\n请严格按照格式输出，每个数据单独一行。` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级路径：${layerPath}\n\nHTML内容：\n${treeText.substring(0, firstExtractSize)}\n\n请根据目标层级路径提取数据，每个数据单独一行！` }
  ];
  
  sendProgress('🤖 LLM正在根据层级提取数据...');
  let result = await callLLM(extractMessages);
  sendProgress('✅ 数据提取完成，正在验证内容是否符合需求...');
  
  // 验证提取的内容是否符合用户需求
  let verifyMessages = [
    { role: 'system', content: `你是数据验证专家。判断提取的内容是否符合用户需求。

判断标准：
- 内容是否是用户想要的类型
- 内容是否有意义（非空、非垃圾数据）

只输出JSON格式：
{"符合需求": true/false, "理由": "为什么符合/不符合"}` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n提取的内容：\n${result.substring(0, 2000)}\n\n请判断这些内容是否符合用户需求。` }
  ];
  
  let verifyResult = await callLLM(verifyMessages);
  sendProgress('📋 验证结果: ' + verifyResult.substring(0, 200));
  
  // 检查是否符合需求
  let isValid = verifyResult.includes('"符合需求": true') || verifyResult.includes('"符合需求":true') || verifyResult.includes('符合需求": true');
  
  if (!isValid) {
    sendProgress('⚠️ 提取的内容不符合需求，继续查找...');
    // 返回空，让外层继续循环查找
    return '';
  }
  
  sendProgress('✅ 内容验证通过！');
  
  // 继续获取更多数据 - 从第一次提取结束的位置开始
  sendProgress('📥 继续获取更多数据...');
  let moreResult = await getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, firstExtractSize, sendProgress);
  
  return result + '\n\n' + moreResult;
}

// 根据层级继续获取更多数据
async function getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, startOffset, sendProgress) {
  let maxChars = 20000;
  let allData = '';
  let moreCount = 1;
  
  // 使用已识别的格式标签
  let formatPrompt = `${formatLabel}N: xxx (每个数据单独一行)`;
  
  while (startOffset < treeText.length) {
    sendProgress(`📥 继续获取第${moreCount}批数据 (范围 ${startOffset}-${startOffset + maxChars})...`);
    
    let segment = treeText.substring(startOffset, startOffset + maxChars);
    if (!segment) break;
    
    let messages = [
      { role: 'system', content: `提取数据，如果这个范围没有新数据返回"无更多数据"。\n\n重要：每个数据单独一行输出！\n\n格式示例：\n${formatLabel}1: xxx\n${formatLabel}2: xxx\n\n只输出数据，不要解释。` },
      { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级：${layerPath}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据，每个单独一行！` }
    ];
    
    let result = await callLLM(messages);
    sendProgress(`📥 第${moreCount}批提取完成，检查是否有更多...`);
    
    if (result.includes('无更多数据') || result.includes('没有新数据')) {
      sendProgress('✅ 已获取所有数据');
      break;
    }
    
    allData += result + '\n';
    startOffset += maxChars;
    moreCount++;
    
    // 防止无限循环
    if (moreCount > 50) {
      sendProgress('⚠️已达最大提取次数');
      break;
    }
  }
  
  return allData;
}

// 找到后，继续获取更多数据 - 每次增加5000直到无新数据
async function getMoreResults(treeText, userRequirement, startOffset, sendProgress) {
  let maxChars = 5000; // 每次增加5000
  let allData = '';
  let moreCount = 1;
  
  while (startOffset < treeText.length) {
    sendProgress(`📥 正在获取更多数据 (第${moreCount}批, 范围 ${startOffset}-${startOffset + maxChars})...`);
    
    let segment = treeText.substring(startOffset, startOffset + maxChars);
    if (!segment) break;
    
    let messages = [
      { role: 'system', content: '提取数据，如果这个范围没有新数据返回"无更多数据"。只输出数据，不要解释。' },
      { role: 'user', content: `用户需求：${userRequirement}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据。` }
    ];
    
    let result = await callLLM(messages);
    sendProgress(`💭 思考中: 检查第${moreCount}批是否有新数据...`);
    sendProgress(`💭 思考中: 批次${moreCount}数据提取完成，检查是否有更多数据...`);
    if (result.includes('无更多数据') || result.includes('没有新数据')) {
      sendProgress('✅ 已获取所有数据');
      break;
    }
    
    allData += result + '\n';
    startOffset += maxChars;
    moreCount++;
  }
  
  return allData;
}

async function getPageTree(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getTree' }, (response) => {
      resolve(response?.treeText || null);
    });
  });
}

async function getFullPageTree(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getFullTree' }, (response) => {
      resolve(response?.treeText || null);
    });
  });
}
