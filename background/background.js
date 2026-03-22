// background/background.js - 后台脚本

// 全局变量存储滚动容器和翻页按钮
let globalScrollContainers = [];
let globalPaginationButtons = [];
let globalUserRequirement = '';
let globalExtractedData = new Set(); // 已爬取的数据用于去重
let globalSkipConfirm = false; // 反思后跳过确认
let globalSelector = ''; // CSS选择器，用于快速提取数据
let globalDataIndex = 0; // 全局数据索引，保证编号连续
let globalLazyAttr = 'src'; // 懒加载属性
let globalFilterPatterns = []; // 过滤模式（由LLM根据具体网站分析得出）

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
  
  // 滚动容器和翻页检测 - 转发到content script
  if (['findScrollable', 'findPagination', 'doScroll', 'smoothScroll', 'doClickPagination'].includes(request.action)) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, request, (response) => {
        sendResponse(response);
      });
    });
    return true;
  }
  
  // LLM分析翻页候选元素
  if (request.action === 'analyzePaginationCandidates') {
    const candidates = request.candidates || [];
    
    const messages = [
      { role: 'system', content: `你是网页元素分析专家。根据页面上下文，判断哪些元素是"下一页"按钮。

重要的筛选规则：
- 只识别"下一页"按钮，排除"上一页"、"上一页"、"previous"、"上一步"、"<"、"<<"等
- 正确的下一页特征：文本包含"下一页"、"Next"、"下一页"、"更多"、"加载更多"、"page >"、">>"、"后一页"等
- 错误的上一页特征：文本包含"上一页"、"上一页"、"previous"、"上一步"、"<"、<<"等
- 位置：在页面底部或列表下方
- 标签：通常是<a>、<button>或可点击的元素
- 类名可能包含：page、pager、pagination、next、more、arrow等

请从候选列表中只筛选出"下一页"按钮。
只返回下一页按钮的索引编号，格式：1,3,5（用逗号分隔）
如果不认为有任何下一页按钮，返回"无"` },
      { role: 'user', content: `页面候选元素列表：\n${candidates.map((c, i) => `[${i}] <${c.tag}> "${c.text}" class="${c.class.substring(0, 30)}" id="${c.id}"`).join('\n')}\n\n请判断哪些是翻页按钮，只返回索引编号。` }
    ];
    
    callLLM(messages).then(result => {
      sendResponse({ result: result });
    }).catch(err => {
      sendResponse({ error: err.message });
    });
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

// 持续滚动容器（模拟人类）
async function smoothScrollContainer(tabId, containerIndex, sendProgress) {
  const stopKey = 'smoothScrollStop';
  await chrome.storage.local.set({ [stopKey]: false });
  
  sendProgress(`📜 开始持续滚动...`);
  
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {
      action: 'smoothScroll',
      index: containerIndex,
      stopKey: stopKey
    }, (response) => {
      if (response?.success) {
        sendProgress(`📜 滚动完成: ${response.reason}`);
      } else {
        sendProgress(`⚠️ 滚动失败: ${response?.error}`);
      }
      resolve(response);
    });
  });
}

// 检测滚动容器和翻页按钮
async function detectScrollAndPagination(tabId, sendProgress) {
  // 检测滚动容器
  const scrollResponse = await chrome.tabs.sendMessage(tabId, { action: 'findScrollable' });
  const scrollContainers = scrollResponse?.containers || [];
  sendProgress(`📜 检测到 ${scrollContainers.length} 个滚动容器`);
  
  // 检测翻页候选元素
  const paginationResponse = await chrome.tabs.sendMessage(tabId, { action: 'findPagination' });
  const candidates = paginationResponse?.candidates || [];
  
  // 让 LLM 判断哪些是下一页按钮
  let paginationButtons = [];
  if (candidates.length > 0) {
    const messages = [
      { role: 'system', content: `你是网页元素分析专家。根据页面上下文，判断哪些元素是"下一页"按钮。

重要的筛选规则：
- 只识别"下一页"按钮，排除"上一页"、"上一页"、"previous"、"上一步"、"<"、"<<"等
- 正确的下一页特征：文本包含"下一页"、"Next"、"下一页"、"更多"、"加载更多"、"page >"、">>"、"后一页"等
- 错误的上一页特征：文本包含"上一页"、"上一页"、"previous"、"上一步"、"<"、<<"等
- 位置：在页面底部或列表下方
- 标签：通常是<a>、<button>或可点击的元素
- 类名可能包含：page、pager、pagination、next、more、arrow等

请从候选列表中只筛选出"下一页"按钮。
只返回下一页按钮的索引编号，格式：1,3,5（用逗号分隔）
如果不认为有任何下一页按钮，返回"无"` },
      { role: 'user', content: `页面候选元素列表：\n${candidates.map((c, i) => `[${i}] <${c.tag}> "${c.text}" class="${c.class.substring(0, 30)}" id="${c.id}"`).join('\n')}\n\n请判断哪些是翻页按钮，只返回索引编号。` }
    ];
    
    const llmResult = await callLLM(messages);
    const llmResultStr = llmResult || '';
    
    // 解析 LLM 返回的索引
    const paginationIndices = [];
    if (llmResultStr && llmResultStr !== '无' && llmResultStr !== 'none') {
      const matches = llmResultStr.match(/[\d,]+/g);
      if (matches) {
        matches[0].split(',').forEach(i => {
          const idx = parseInt(i.trim());
          if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
            paginationIndices.push(idx);
          }
        });
      }
    }
    
    paginationButtons = paginationIndices.map(i => candidates[i]).filter(Boolean);
    sendProgress(`🔄 检测到 ${paginationButtons.length} 个下一页按钮`);
  } else {
    sendProgress(`🔄 未检测到翻页候选元素`);
  }
  
  return { scrollContainers, paginationButtons };
}

// 分析策略：分层提取
async function analyzeWithStrategy(treeText, userRequirement, tabId, sendProgress) {
  try {
    // 重置全局状态，避免污染
    globalScrollContainers = [];
    globalPaginationButtons = [];
    globalUserRequirement = '';
    globalExtractedData = new Set();
    globalSkipConfirm = false;
    globalSelector = '';
    globalDataIndex = 0;
    globalLazyAttr = 'src';
    globalFilterPatterns = [];
    
    // 同时发送到content script显示进度
    const sendProgressToPage = (msg) => {
      console.log('发送进度:', msg);
      sendProgress(msg);
      chrome.tabs.sendMessage(tabId, { action: 'progress', message: msg }).catch((err) => {
        console.log('发送失败:', err);
      });
    };
    
    // ====== 第一步：检测滚动容器和翻页按钮 ======
    sendProgressToPage('🔍 正在检测滚动容器和翻页按钮...');
    const { scrollContainers, paginationButtons } = await detectScrollAndPagination(tabId, sendProgressToPage);
    globalScrollContainers = scrollContainers;
    globalPaginationButtons = paginationButtons;
    globalUserRequirement = userRequirement;
    
    // 获取完整内容树（用于数据提取）
    sendProgressToPage('📄 正在获取页面完整内容...');
    const fullTreeText = await getFullPageTree(tabId);
    if (!fullTreeText) {
      sendProgressToPage('⚠️ 获取完整内容失败，使用框架结构');
    }
    sendProgressToPage(`📄 页面结构已获取 (框架: ${treeText.length} 字符, 完整: ${fullTreeText?.length || 0} 字符)`);

    // ====== 第一步：完整框架结构，层级分析 ======
    sendProgressToPage('🔍 正在分析页面层级结构 (1/3)...');
    
    // 限制框架长度，防止超出 API 上下文限制
    const maxFrameworkChars = 80000;
    let fullFramework = treeText;
    if (fullFramework.length > maxFrameworkChars) {
      fullFramework = fullFramework.substring(0, maxFrameworkChars) + `\n...[内容过长，已截断，剩余 ${treeText.length - maxFrameworkChars} 字符]`;
    }
    sendProgressToPage(`📄 已获取完整框架结构 (${fullFramework.length} 字符)`);
    
    let messages = [
      { role: 'system', content: `你是一个网页结构分析助手。根据用户需求"${userRequirement}"，分析HTML树形结构。

请严格按照以下格式输出：
---分析开始---
[在这里详细描述你观察到的HTML结构，特别是哪些标签、class、id可能包含目标数据]

---层级判断---
{"层级路径": "如 div.product-list > ul > li", "包含的属性": "如 class='product-item' id='item-1'", "是否找到": true/false, "当前深度": 数字, "理由": "为什么选择这个层级"}` },
      { role: 'user', content: `用户需求：${userRequirement}\n\nHTML结构（完整框架，不含文本内容，共${fullFramework.length}字符）：\n${fullFramework}` }
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
    let consecutiveFailures = 0;
    let lastLayerPath = '';
    let triedLayers = new Set();
    let totalFailures = 0;  // 总失败次数
    const fullContent = fullTreeText || treeText;
    
    // 尝试从层级分析得到的路径开始
    let startLayerPath = '';
    if (result.includes('"是否找到": true') || result.includes('"是否找到":true')) {
      startLayerPath = result.match(/"层级路径":\s*"([^"]+)"/)?.[1] || '';
      if (startLayerPath) {
        sendProgressToPage(`✅ 层级分析找到目标层级: ${startLayerPath}`);
        sendProgressToPage('📥 正在提取并验证...');
        
        // 提取并验证（带offset）
        let extractResult = await extractByLayer(fullContent, userRequirement, startLayerPath, tabId, sendProgressToPage, offset);
        
        if (extractResult && extractResult.length > 10) {
          found = true;
          return extractResult;
        } else {
          // 首次尝试失败，记录并继续
          triedLayers.add(startLayerPath);
          consecutiveFailures++;
          totalFailures++;
          sendProgressToPage(`⚠️ 首次尝试失败 (${totalFailures}次总失败)，继续寻找...`);
        }
      }
    }
    
    sendProgressToPage('🔄 开始循环验证查找...');
    
    // 快速跳过明显无关的区域
    const skipKeywords = [];
    
    // 从上一次分析的层级位置继续
    while (offset < fullContent.length) {
      sendProgressToPage(`🔍 正在深度分析 (${loopCount})，范围: ${offset}-${offset + 20000}...`);
      
      let segment = fullContent.substring(offset, offset + 20000);
      if (!segment) break;
      
      messages[1].content = `用户需求：${userRequirement}\n\nHTML层级结构（深度${currentDepth + 1}，当前偏移${offset}）：\n${segment}\n\n请严格按照格式输出：\n---分析开始---\n[详细描述这个层级的结构，观察是否包含用户需要的数据（可能是文本、链接、图片、价格、评论、标题、音频、视频、文件等任何内容）]\n\n---判断结果---\n{"是否找到": true/false, "层级路径": "如 div.class", "包含的属性": "如 id='xxx'", "理由": "为什么选择"}`;
      
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
      let isFound = result.includes('"是否找到": true') || result.includes('"是否找到":true');
      
      if (layerPath) {
        sendProgressToPage(`📍 当前深度${currentDepth + 1}可能层级: ${layerPath}`);
        sendProgressToPage(`🏷️ 该层级属性: ${layerAttrs}`);
      }
      
      // ====== 智能跳过明显无关区域 ======
      let shouldSkip = false;
      for (let kw of skipKeywords) {
        if (layerPath.toLowerCase().includes(kw.toLowerCase()) || 
            loopAnalysisPart.toLowerCase().includes(kw.toLowerCase())) {
          sendProgressToPage(`⏭ 跳过无关区域 (${kw}): ${layerPath}`);
          shouldSkip = true;
          break;
        }
      }
      
      if (shouldSkip) {
        offset += 20000;
        currentDepth++;
        loopCount++;
        totalFailures++;
        continue;
      }
      
      // ====== 反思机制：连续5次或总失败10次时触发 ======
      consecutiveFailures++;
      totalFailures++;
      
      if (consecutiveFailures >= 5 || totalFailures >= 10) {
        sendProgressToPage(`⚠️ 已连续失败 ${consecutiveFailures} 次 (共 ${totalFailures} 次)，触发反思机制...`);
        
        // 让LLM重新思考
        let reflectionMessages = [
          { role: 'system', content: `你是网页数据定位专家。用户想要的数据是："${userRequirement}"

已尝试过的路径：${Array.from(triedLayers).join(', ')}

你需要：
1. 重新分析HTML结构
2. 找出可能包含目标数据的正确位置
3. 给出新的、更可能包含目标数据的层级路径

提示：目标数据可能是文本、链接、图片、价格、评论、标题、音频、视频、文件等任何内容，不限于特定类型。` },
          { role: 'user', content: `用户需求：${userRequirement}
已尝试过的路径：${Array.from(triedLayers).join(', ')}

当前HTML片段（偏移${offset}）：
${segment}

请重新分析并给出一个新的、更可能包含目标数据的层级路径。格式：
{"新的层级路径": "xxx", "理由": "为什么这个路径可能不同", "建议偏移量": 数字}` }
        ];
        
        try {
          let reflectionResult = await callLLM(reflectionMessages);
          
          // 提取新的路径和建议偏移量
          let newPathMatch = reflectionResult.match(/"新的层级路径":\s*"([^"]+)"/);
          let newOffsetMatch = reflectionResult.match(/"建议偏移量":\s*(\d+)/);
          
          if (newPathMatch) {
            layerPath = newPathMatch[1];
            sendProgressToPage(`🔄 反思后选择新路径: ${layerPath}`);
            triedLayers.add(layerPath);
          }
          
          // 如果LLM建议了新偏移量，直接跳转
          if (newOffsetMatch) {
            let suggestedOffset = parseInt(newOffsetMatch[1]);
            if (suggestedOffset > offset) {
              offset = suggestedOffset;
              sendProgressToPage(`⏭ 反思建议跳转至偏移: ${offset}`);
            }
          }
          
          // 重置连续失败计数
          consecutiveFailures = 0;
        } catch (e) {
          sendProgressToPage(`⚠️ 反思过程出错: ${e.message}`);
          continue;
        }
      } else if (!triedLayers.has(layerPath)) {
        triedLayers.add(layerPath);
        lastLayerPath = layerPath;
      }
      
      // 根据层级路径提取数据（使用当前offset）
      sendProgressToPage('📥 根据该层级提取数据...');
      let extractResult = await extractByLayer(fullContent, userRequirement, layerPath, tabId, sendProgressToPage, offset);
      
      // 检查是否是用户拒绝
      if (extractResult === 'USER_REJECTED') {
        sendProgressToPage('❌ 用户拒绝数据，正在分析拒绝原因...');
        
        // 先分析用户拒绝的原因
        let analyzeRejectMessages = [
          { role: 'system', content: `你是分析专家。用户拒绝了你提取的数据，你需要分析可能的原因。

分析维度：
1. 数据类型不对？例如：要的是标题，却提取了描述
2. 数据不完整？例如：只提取了部分
3. 位置不对？例如：在错误的区域提取
4. 格式不对？例如：格式不符合用户预期

请简洁分析可能的原因。` },
          { role: 'user', content: `用户需求：${userRequirement}
之前提取时使用的层级路径：${layerPath}

请分析用户拒绝的可能原因是什么？` }
        ];
        
        let rejectReason = await callLLM(analyzeRejectMessages);
        sendProgressToPage(`📋 拒绝原因分析: ${rejectReason.substring(0, 200)}`);
        
        // 然后基于原因反思
        sendProgressToPage('🔄 反思机制启动...');
        triedLayers.add(layerPath);
        consecutiveFailures = 5;
        totalFailures++;
        
        let reflectionMessages = [
          { role: 'system', content: `你是网页数据定位专家。用户想要的数据是："${userRequirement}"
之前的层级路径：${layerPath}
用户拒绝原因：${rejectReason}

已尝试过的路径：${Array.from(triedLayers).join(', ')}

你需要：
1. 根据拒绝原因，重新分析HTML结构
2. 找出真正包含目标数据的正确位置
3. 给出新的层级路径和偏移量` },
          { role: 'user', content: `请根据拒绝原因 "${rejectReason}" 重新分析。

请给出：
1. 新的层级路径
2. 建议的偏移量（数字）

格式：
{"新的层级路径": "xxx", "理由": "xxx", "建议偏移量": 数字}` }
        ];
        
        try {
          let reflectionResult = await callLLM(reflectionMessages);
          let newPathMatch = reflectionResult.match(/"新的层级路径":\s*"([^"]+)"/);
          let newOffsetMatch = reflectionResult.match(/"建议偏移量":\s*(\d+)/);
          
          if (newPathMatch) {
            layerPath = newPathMatch[1];
            sendProgressToPage(`🔄 反思后选择新路径: ${layerPath}`);
            triedLayers.add(layerPath);
          }
          
          if (newOffsetMatch) {
            offset = parseInt(newOffsetMatch[1]);
            sendProgressToPage(`⏭ 反思建议跳转至偏移: ${offset}`);
          }
          
          consecutiveFailures = 0;  // 重置
          // 继续循环，不增加offset
          continue;
        } catch (e) {
          sendProgressToPage(`⚠️ 反思出错: ${e.message}`);
          continue;
        }
      }
      
      // 检查是否包含目标数据
      const hasTargetData2 = extractResult && extractResult.length > 10 && 
        !extractResult.includes('未找到') && !extractResult.includes('没有');
      
      // 检查是否是成功提取完成（包括用户停止后的数据）
      const isSuccessfullyExtracted = extractResult && extractResult.length > 10 && 
        (extractResult.includes('已获取所有数据') || extractResult.includes('用户中断') || 
         !extractResult.includes('未找到'));
      
      if (hasTargetData2 || isSuccessfullyExtracted) {
        found = true;
        sendProgressToPage(`✅ 数据提取完成，共 ${extractResult.length} 字符`);
        return extractResult;
      } else {
        consecutiveFailures++;
        totalFailures++;
        sendProgressToPage(`⚠️ 该位置未找到数据 (累计${totalFailures}次失败)，继续查找...`);
      }
      
      currentDepth++;
      offset += 20000;
      loopCount++;
      
      // 防止无限循环
      if (loopCount > 50 || totalFailures > 50) {
        sendProgressToPage('⚠️ 已达最大分析次数或失败次数过多');
        break;
      }
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

// 根据层级路径提取数据（支持offset）
async function extractByLayer(treeText, userRequirement, layerPath, tabId, sendProgress, startOffset = 0) {
  sendProgress(`🎯 根据层级路径 "${layerPath}" 提取数据 (从位置${startOffset}开始)...`);
  
  // 让LLM根据用户需求自动判断输出格式
  let formatMessages = [
    { role: 'system', content: `你是格式分析专家。根据用户的提取需求，判断最合适的输出格式标签。

用户需求示例和对应格式：
- "小说标题" → "标题"
- "评论内容" → "评论"  
- "商品价格" → "价格"
- "图片链接" → "图片"
- "文章文本" → "段落"
- "视频地址" → "视频"
- "下载链接" → "链接"

只输出一个最合适的标签，不要其他内容。` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n请判断输出格式标签是什么？` }
  ];
  
  let formatLabel = await callLLM(formatMessages);
  formatLabel = formatLabel.trim().replace(/[，。]/g, '');
  
  sendProgress(`📋 识别到数据类型: ${formatLabel}`);
  
  // 根据识别的格式标签构建输出格式
  let formatPrompt = `${formatLabel}1: xxx\n${formatLabel}2: xxx\n${formatLabel}3: xxx`;
  
  // 第一次提取 - 从startOffset开始，使用较多字符（比如50000）
  let firstExtractSize = 50000;
  let extractStart = startOffset;
  sendProgress(`📊 第一次提取 (从${extractStart}开始，前${firstExtractSize}字符)...`);
  
  let extractMessages = [
    { role: 'system', content: `你是网页数据提取专家。只输出提取的数据，不要解释。

⚠️ 重要：如果HTML中没有符合需求的数据，输出"无数据"，不要凭空创造！

输出格式示例：
${formatPrompt}

如果没找到数据，只输出"无数据"不要输出其他内容。` },
    { role: 'user', content: `用户需求：${userRequirement}

目标层级路径：${layerPath}
注意：只从位置 ${extractStart} 之后的HTML中提取，不要回头找前面的内容！

HTML内容（从${extractStart}开始）：
${treeText.substring(extractStart, extractStart + firstExtractSize)}

请严格按照格式输出。每个数据单独一行。如果HTML中没有数据，输出"无数据"。` }
  ];
  
  sendProgress('🤖 LLM正在根据层级提取数据...');
  let result = await callLLM(extractMessages);
  
  // 检查是否返回"无数据"
  if (result.includes('无数据') || result.trim() === '') {
    sendProgress('⚠️ 该层级未找到数据，继续查找...');
    return '';
  }
  
  sendProgress('✅ 数据提取完成，正在验证内容是否符合需求...');
  
  // 验证提取的内容是否真实存在于HTML中（从相同位置验证）
  let verifyMessages = [
    { role: 'system', content: `你是数据验证专家。判断提取的内容是否真实存在于HTML中。

判断标准（满足任意一条即可）：
1. 至少有部分数据真实出现在HTML中（不需要全部匹配）
2. 内容是用户想要的类型
3. 内容有实际意义（非空、非垃圾数据）

注意：如果是分批次提取，后面批次的部分内容可能在当前HTML片段中找不到，这是正常的。

只输出JSON格式：
{"符合需求": true/false, "理由": "为什么符合/不符合", "真实存在的数量": 数字}` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n提取的内容：\n${result.substring(0, 2000)}\n\n原始HTML（从位置${extractStart}开始，30000字符）：\n${treeText.substring(extractStart, extractStart + 30000)}\n\n请判断这些内容是否真实存在于上述HTML中。` }
  ];
  
  let verifyResult = await callLLM(verifyMessages);
  sendProgress('📋 验证结果: ' + verifyResult.substring(0, 200));
  
  // 检查是否符合需求
  let isValid = verifyResult.includes('"符合需求": true') || verifyResult.includes('"符合需求":true') || verifyResult.includes('符合需求": true');
  
  if (!isValid) {
    sendProgress('⚠️ 提取的内容不符合需求，继续查找...');
    return '';
  }
  
  sendProgress('✅ 内容验证通过！');
  
  // ====== 用户确认机制 ======
  sendProgress('⏸ 等待用户确认数据是否正确...');
  
  // 发送确认请求给content script
  await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { 
      action: 'requestUserConfirm', 
      data: result.substring(0, 1500),  // 截取部分数据展示
      requirement: userRequirement
    }, (response) => {
      resolve(response?.confirmed ?? false);
    });
  });
  
  // 检查用户是否确认
  const { userConfirmed } = await chrome.storage.local.get('userConfirmed');
  await chrome.storage.local.set({ userConfirmed: false }); // 重置状态
  
  if (!userConfirmed) {
    sendProgress('❌ 用户拒绝该数据，触发反思机制重新寻找...');
    // 返回特殊标记让外层立即触发反思
    return 'USER_REJECTED';
  }
  
  sendProgress('✅ 用户确认数据正确，继续获取更多数据...');
  
  // 如果还没有选择器，让LLM基于已提取的数据生成
  if (!globalSelector && layerPath) {
    sendProgress('🤖 正在生成CSS选择器...');
    const htmlSegment = treeText.substring(extractStart, extractStart + firstExtractSize);
    globalSelector = await generateSelector(layerPath, userRequirement, result, htmlSegment, sendProgress, tabId);
    if (globalSelector) {
      sendProgress(`✅ CSS选择器已生成: ${globalSelector}`);
    }
  }
  
  // 将已确认的数据加入全局去重集合，并重新格式化
  const extractValue = (line) => {
    const match = line.match(/:\s*(.+)$/);
    return match ? match[1].trim() : line.trim();
  };
  
  const resultLines = result.split('\n').filter(l => l.trim());
  const resultValues = resultLines.map(extractValue);
  resultValues.forEach(val => globalExtractedData.add(val.toLowerCase()));
  sendProgress(`🔄 已将 ${resultValues.length} 条数据加入去重集合`);
  
  // 用全局索引重新格式化
  const startIndex = globalDataIndex + 1;
  const formattedResult = resultValues.map((val, i) => `${formatLabel}${startIndex + i}: ${val}`).join('\n');
  globalDataIndex = startIndex + resultValues.length - 1;
  
  // 继续获取更多数据 - 从第一次提取结束的位置开始
  sendProgress('📥 继续获取更多数据...');
  let moreResult = await getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, extractStart + firstExtractSize, tabId, sendProgress);
  
  return formattedResult + '\n' + moreResult;
}

// 根据层级继续获取更多数据
async function getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, startOffset, tabId, sendProgress) {
  let maxChars = 20000;
  let allData = '';
  let moreCount = 1;
  let lastPageUrl = '';
  
  // 使用已识别的格式标签
  let formatPrompt = `${formatLabel}N: xxx (每个数据单独一行)`;
  

  
  // 获取初始页面URL
  try {
    const tab = await chrome.tabs.get(tabId);
    lastPageUrl = tab.url;
  } catch (e) {}
  
  // ====== 如果有选择器，直接一次性提取 ======
  if (globalSelector) {
    sendProgress(`🔍 使用选择器一次性提取所有数据...`);
    
    // 循环提取直到没有新数据
    let selectorFailCount = 0;
    while (true) {
      const { stopExtract } = await chrome.storage.local.get('stopExtract');
      if (stopExtract) {
        sendProgress('⏹ 用户中断提取');
        await chrome.storage.local.set({ stopExtract: false });
        break;
      }
      
      const selectorData = await extractBySelector(tabId, userRequirement, formatLabel, sendProgress);
      
      if (!selectorData || selectorData.length === 0) {
        selectorFailCount++;
        sendProgress(`⚠️ 选择器未提取到数据 (第${selectorFailCount}次)`);
        
        // 如果连续失败3次，尝试重新生成选择器
        if (selectorFailCount >= 3) {
          sendProgress('🔄 选择器多次失败，尝试重新生成...');
          const newTree = await getFullPageTree(tabId);
          if (newTree) {
            const newSelector = await generateSelector(layerPath, userRequirement, '', newTree, sendProgress, tabId);
            if (newSelector && newSelector !== globalSelector) {
              globalSelector = newSelector;
              sendProgress(`✅ 新选择器: ${globalSelector}`);
              selectorFailCount = 0;
              continue;
            }
          }
          sendProgress('⚠️ 重新生成选择器失败，回退到LLM提取');
          break;
        }
        
        // 等待一下再试
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      
      // 去重后格式化
      const uniqueData = [];
      for (const item of selectorData) {
        const trimmed = item.trim().toLowerCase();
        if (!globalExtractedData.has(trimmed)) {
          globalExtractedData.add(trimmed);
          uniqueData.push(item.trim());
        }
      }
      
      if (uniqueData.length === 0) {
        sendProgress('✅ 所有数据已提取，无新数据');
        break;
      }
      
      // 使用全局索引保证编号连续
      const startIndex = globalDataIndex + 1;
      const formatted = uniqueData.map((item, i) => `${formatLabel}${startIndex + i}: ${item}`).join('\n');
      globalDataIndex = startIndex + uniqueData.length - 1;
      allData = allData ? allData + '\n' + formatted : formatted;
      sendProgress(`🔍 本次提取 ${uniqueData.length} 条数据，累计 ${globalDataIndex} 条`);
      
      // 尝试持续滚动
      if (globalScrollContainers.length > 0) {
        sendProgress(`📜 持续滚动加载更多...`);
        const scrollResult = await smoothScrollContainer(tabId, 0, sendProgress);
        if (scrollResult?.success) {
          sendProgress(`📜 滚动完成，等待图片加载...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      } else {
        break;
      }
    }
    
    // 尝试翻页
    if (globalPaginationButtons.length > 0 && allData) {
      sendProgress('🔄 尝试翻页...');
      
      for (let i = 0; i < globalPaginationButtons.length; i++) {
        const btn = globalPaginationButtons[i];
        const clickResult = await chrome.tabs.sendMessage(tabId, { action: 'doClickPagination', text: btn.text });
        
        if (clickResult?.success) {
          sendProgress(`🔄 已点击翻页按钮，等待加载...`);
          await new Promise(r => setTimeout(r, 3000));
          
          let isNewPage = false;
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.url !== lastPageUrl) {
              isNewPage = true;
              lastPageUrl = tab.url;
              sendProgress(`🔄 检测到新页面`);
            }
          } catch (e) {}
          
          if (!isNewPage) {
            const newTree = await getFullPageTree(tabId);
            if (newTree && newTree.length > treeText.length * 1.2) {
              isNewPage = true;
            }
          }
          
          if (isNewPage) {
            sendProgress('🔄 继续从新页面提取...');
            // 递归继续提取
            const moreData = await getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, 0, tabId, sendProgress);
            allData += '\n' + moreData;
            break;
          }
        }
      }
    }
    
    return allData;
  }
  
  // ====== 没有选择器，用LLM分批提取（照旧） ======
  while (startOffset < treeText.length) {
    // 检查用户是否点击停止
    const { stopExtract } = await chrome.storage.local.get('stopExtract');
    if (stopExtract) {
      sendProgress('⏹ 用户中断提取');
      await chrome.storage.local.set({ stopExtract: false });
      return allData;
    }
    
    let result = '';
    
    // 优先使用选择器提取
    if (globalSelector) {
      sendProgress(`🔍 使用选择器快速提取...`);
      const selectorData = await extractBySelector(tabId, userRequirement, formatLabel, sendProgress);
      if (selectorData && selectorData.length > 0) {
        // 直接使用纯数据，后续统一格式化
        result = selectorData.join('\n');
      }
    }
    
    // 如果选择器没提取到，用LLM
    if (!result) {
      sendProgress(`📥 继续获取第${moreCount}批数据 (范围 ${startOffset}-${startOffset + maxChars})...`);
      
      let segment = treeText.substring(startOffset, startOffset + maxChars);
      if (!segment) break;
      
      let messages = [
        { role: 'system', content: `提取数据，如果这个范围没有新数据返回"无更多数据"。\n\n重要：每个数据单独一行输出！\n\n格式示例：\n${formatLabel}1: xxx\n${formatLabel}2: xxx\n\n只输出数据，不要解释。` },
        { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级：${layerPath}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据，每个单独一行！` }
      ];
      
      result = await callLLM(messages);
    }
    
    sendProgress(`📥 第${moreCount}批提取完成，检查是否有更多...`);
    
    if (result.includes('无更多数据') || result.includes('没有新数据')) {
      // ====== 尝试滚动或翻页 ======
      sendProgress('⚠️ 当前页无更多数据，尝试滚动或翻页...');
      
      let foundNewData = false;
      
      // 1. 尝试持续滚动滚动容器
      if (globalScrollContainers.length > 0) {
        sendProgress(`📜 持续滚动加载更多...`);
        const scrollResult = await smoothScrollContainer(tabId, 0, sendProgress);
        if (scrollResult?.success) {
          sendProgress(`📜 滚动完成，等待图片加载...`);
          await new Promise(r => setTimeout(r, 3000));
          
          // 优先使用选择器提取
          let newData = null;
          if (globalSelector) {
            newData = await extractBySelector(tabId, userRequirement, formatLabel, sendProgress);
          }
          
          // 如果选择器没提取到，用LLM
          if (!newData || newData.length === 0) {
            const newFullTree = await getFullPageTree(tabId);
            if (newFullTree && newFullTree.length > treeText.length) {
              newData = await extractNewData(newFullTree, treeText.length, userRequirement, layerPath, formatLabel, sendProgress);
            }
          }
          
          if (newData && newData.length > 0) {
            sendProgress(`📜 滚动后发现 ${newData.length} 个新数据`);
            allData += newData + '\n';
            treeText = await getFullPageTree(tabId);
            foundNewData = true;
          }
        }
      }
      
      // 2. 如果滚动没用，尝试翻页
      if (!foundNewData && globalPaginationButtons.length > 0) {
        sendProgress(`🔄 尝试点击翻页按钮...`);
        
        for (let i = 0; i < globalPaginationButtons.length; i++) {
          const btn = globalPaginationButtons[i];
          const clickResult = await chrome.tabs.sendMessage(tabId, { action: 'doClickPagination', text: btn.text });
          
          if (clickResult?.success) {
            sendProgress(`🔄 已点击翻页按钮 ${i + 1}，等待加载...`);
            await new Promise(r => setTimeout(r, 3000));
            
            // 检测是否真的到了新页面
            let isNewPage = false;
            let newPageUrl = '';
            try {
              const tab = await chrome.tabs.get(tabId);
              newPageUrl = tab.url;
              if (tab.url !== lastPageUrl) {
                isNewPage = true;
                lastPageUrl = tab.url;
                sendProgress(`🔄 检测到新页面: ${tab.url.substring(0, 50)}...`);
              }
            } catch (e) {}
            
            // 如果没有URL变化，检测DOM变化（必须比原来大很多才算）
            if (!isNewPage) {
              const newFullTree = await getFullPageTree(tabId);
              // 必须是原来的 1.2 倍以上才算真正有新内容
              if (newFullTree && newFullTree.length > treeText.length * 1.2) {
                isNewPage = true;
                sendProgress(`🔄 DOM内容明显增加: ${treeText.length} → ${newFullTree.length}`);
              } else {
                sendProgress(`⚠️ 页面长度未明显变化: ${treeText.length} → ${newFullTree?.length || 0}`);
              }
            }
            
            if (isNewPage) {
              // 优先使用选择器提取
              let newData = null;
              if (globalSelector) {
                newData = await extractBySelector(tabId, userRequirement, formatLabel, sendProgress);
              }
              
              // 如果选择器没提取到，用LLM
              if (!newData || newData.length === 0) {
                const newFullTree = await getFullPageTree(tabId);
                newData = await extractNewData(newFullTree, 0, userRequirement, layerPath, formatLabel, sendProgress);
              }
              
              if (newData && newData.length > 0) {
                sendProgress(`🔄 翻页后发现 ${newData.length} 个新数据`);
                allData += newData + '\n';
                treeText = await getFullPageTree(tabId);
                startOffset = 0;
                foundNewData = true;
                
                // 重新检测翻页按钮
                sendProgress('🔄 重新检测翻页按钮...');
                const { paginationButtons } = await detectScrollAndPagination(tabId, sendProgress);
                globalPaginationButtons = paginationButtons;
                
                break;
              } else {
                sendProgress('⚠️ 翻页后未发现新数据');
              }
            } else {
              sendProgress('⚠️ 翻页后页面未变化');
            }
          }
        }
      }
      
      if (foundNewData) {
        moreCount = 1;
        continue;
      } else {
        sendProgress('✅ 已获取所有数据（滚动和翻页均无新数据）');
        break;
      }
    }
    
    // 去重检测
    const uniqueResult = await deduplicateData(result, allData, sendProgress);
    if (uniqueResult && uniqueResult.length > 0) {
      const lines = uniqueResult.split('\n').filter(l => l.trim());
      const startIndex = globalDataIndex + 1;
      const formatted = lines.map((line, i) => `${formatLabel}${startIndex + i}: ${line}`).join('\n');
      globalDataIndex = startIndex + lines.length - 1;
      allData = allData ? allData + '\n' + formatted : formatted;
      sendProgress(`🔍 本次提取 ${lines.length} 条数据，累计 ${globalDataIndex} 条`);
    }
    
    startOffset += maxChars;
    moreCount++;
    
    if (moreCount > 50) {
      sendProgress('⚠️ 已达最大提取次数');
      break;
    }
  }
  
  // 页面内容已提取完，尝试滚动或翻页加载更多
  sendProgress('⚠️ 页面内容已提取完，尝试滚动或翻页加载更多...');
  
  let foundNewData = false;
  
  // 1. 尝试持续滚动滚动容器
  if (globalScrollContainers.length > 0) {
    sendProgress(`📜 持续滚动加载更多...`);
    const scrollResult = await smoothScrollContainer(tabId, 0, sendProgress);
    if (scrollResult?.success) {
      sendProgress(`📜 滚动完成，等待图片加载...`);
      await new Promise(r => setTimeout(r, 3000));
      
      const newFullTree = await getFullPageTree(tabId);
      if (newFullTree && newFullTree.length > treeText.length) {
        const newData = await extractNewData(newFullTree, treeText.length, userRequirement, layerPath, formatLabel, sendProgress);
        if (newData && newData.length > 0) {
          sendProgress(`📜 滚动后发现新数据，继续提取...`);
          allData += newData + '\n';
          treeText = newFullTree;
          startOffset = treeText.length;
          foundNewData = true;
        }
      }
    }
  }
  
  // 2. 如果滚动没用，尝试翻页
  if (!foundNewData && globalPaginationButtons.length > 0) {
    sendProgress(`🔄 尝试点击翻页按钮...`);
    
    for (let i = 0; i < globalPaginationButtons.length; i++) {
      const btn = globalPaginationButtons[i];
      const clickResult = await chrome.tabs.sendMessage(tabId, { action: 'doClickPagination', text: btn.text });
      
      if (clickResult?.success) {
        sendProgress(`🔄 已点击翻页按钮 ${i + 1}，等待加载...`);
        await new Promise(r => setTimeout(r, 3000));
        
        let isNewPage = false;
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url !== lastPageUrl) {
            isNewPage = true;
            lastPageUrl = tab.url;
            sendProgress(`🔄 检测到新页面: ${tab.url.substring(0, 50)}...`);
          }
        } catch (e) {}
        
        if (!isNewPage) {
          const newFullTree = await getFullPageTree(tabId);
          if (newFullTree && newFullTree.length > treeText.length * 0.5) {
            isNewPage = true;
          }
        }
        
        if (isNewPage) {
          const newFullTree = await getFullPageTree(tabId);
          
          // 翻页后需要重新检测层级路径
          sendProgress('🔄 翻页后重新分析页面结构...');
          const newLayerPath = await detectLayerPath(newFullTree, userRequirement, sendProgress);
          
          if (newLayerPath) {
            sendProgress(`🔄 新页面层级路径: ${newLayerPath}`);
            // 从新页面开头提取数据
            const newData = await extractNewDataWithPath(newFullTree, 0, userRequirement, newLayerPath, formatLabel, sendProgress);
            
            if (newData && newData.length > 0) {
              sendProgress(`🔄 翻页后发现 ${newData.length} 个新数据`);
              allData += newData + '\n';
              treeText = newFullTree;
              layerPath = newLayerPath; // 更新层级路径
              startOffset = treeText.length;
              foundNewData = true;
              
              sendProgress('🔄 重新检测翻页按钮...');
              const { paginationButtons } = await detectScrollAndPagination(tabId, sendProgress);
              globalPaginationButtons = paginationButtons;
              
              break;
            } else {
              sendProgress('⚠️ 翻页后未发现新数据');
            }
          } else {
            sendProgress('⚠️ 无法确定新页面层级路径');
          }
        } else {
          sendProgress('⚠️ 翻页后页面未变化');
        }
      }
    }
  }
  
  if (foundNewData) {
    sendProgress('📥 继续从新页面提取数据...');
    // 继续提取直到没有新数据
    while (startOffset < treeText.length) {
      const { stopExtract } = await chrome.storage.local.get('stopExtract');
      if (stopExtract) {
        sendProgress('⏹ 用户中断提取');
        await chrome.storage.local.set({ stopExtract: false });
        break;
      }
      
      sendProgress(`📥 继续获取数据 (范围 ${startOffset}-${startOffset + maxChars})...`);
      
      let segment = treeText.substring(startOffset, startOffset + maxChars);
      if (!segment) break;
      
      let messages = [
        { role: 'system', content: `提取数据，如果这个范围没有新数据返回"无更多数据"。\n\n格式示例：\n${formatLabel}1: xxx\n${formatLabel}2: xxx\n\n只输出数据，不要解释。` },
        { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级：${layerPath}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据！` }
      ];
      
      let result = await callLLM(messages);
      
      if (result.includes('无更多数据') || result.includes('没有新数据')) {
        break;
      }
      
      const uniqueResult = await deduplicateData(result, allData, sendProgress);
      if (uniqueResult && uniqueResult.length > 0) {
        allData += uniqueResult + '\n';
      }
      
      startOffset += maxChars;
    }
  }
  
  return allData;
}

// 提取新数据（与已爬取数据去重）
async function extractNewData(newTreeText, startOffset, userRequirement, layerPath, formatLabel, sendProgress) {
  const segment = newTreeText.substring(startOffset, startOffset + 20000);
  if (!segment) return '';
  
  let messages = [
    { role: 'system', content: `提取新数据，如果这个范围没有新数据返回"无更多数据"。\n\n重要：每个数据单独一行输出！\n\n格式示例：\n${formatLabel}1: xxx\n${formatLabel}2: xxx\n\n只输出数据，不要解释。` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级：${layerPath}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据，每个单独一行！` }
  ];
  
  let result = await callLLM(messages);
  return await deduplicateData(result, '', sendProgress);
}

// 去重函数
async function deduplicateData(newData, existingData, sendProgress) {
  if (!newData || newData.includes('无更多数据') || newData.includes('没有新数据')) {
    return '';
  }
  
  const newLines = newData.split('\n').filter(l => l.trim());
  
  // 提取纯数据值（去掉索引前缀）
  const extractValue = (line) => {
    const match = line.match(/:\s*(.+)$/);
    return match ? match[1].trim() : line.trim();
  };
  
  const newValues = newLines.map(extractValue);
  const existingSet = new Set(existingData.split('\n').filter(l => l.trim()).map(extractValue).map(v => v.toLowerCase()));
  const globalSet = globalExtractedData;
  
  const uniqueValues = [];
  for (const value of newValues) {
    const valueLower = value.toLowerCase();
    if (!existingSet.has(valueLower) && !globalSet.has(valueLower)) {
      uniqueValues.push(value);
      globalSet.add(valueLower);
    }
  }
  
  if (uniqueValues.length < newValues.length) {
    sendProgress(`🔄 去重过滤了 ${newValues.length - uniqueValues.length} 个重复数据`);
  }
  
  return uniqueValues.join('\n');
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

// 检测新页面的层级路径
async function detectLayerPath(treeText, userRequirement, sendProgress) {
  const maxChars = 30000;
  const segment = treeText.substring(0, maxChars);
  
  const messages = [
    { role: 'system', content: `你是一个网页结构分析助手。根据用户需求"${userRequirement}"，分析HTML树形结构，找出包含目标数据的层级路径。

请严格按照以下格式输出：
---分析开始---
[详细描述你观察到的HTML结构，特别是哪些标签、class、id可能包含目标数据]

---层级判断---
{"层级路径": "如 div.product-list > ul > li", "包含的属性": "如 class='product-item' id='item-1'", "是否找到": true/false}` },
    { role: 'user', content: `用户需求：${userRequirement}\n\nHTML结构（前${segment.length}字符）：\n${segment}` }
  ];
  
  try {
    const result = await callLLM(messages);
    const layerPath = result.match(/"层级路径":\s*"([^"]+)"/)?.[1] || '';
    return layerPath;
  } catch (e) {
    sendProgress(`⚠️ 检测层级路径失败: ${e.message}`);
    return '';
  }
}

// 使用指定层级路径提取数据
async function extractNewDataWithPath(treeText, startOffset, userRequirement, layerPath, formatLabel, sendProgress) {
  const segment = treeText.substring(startOffset, startOffset + 20000);
  if (!segment) return '';
  
  let messages = [
    { role: 'system', content: `提取数据，如果这个范围没有新数据返回"无更多数据"。\n\n重要：每个数据单独一行输出！\n\n格式示例：\n${formatLabel}1: xxx\n${formatLabel}2: xxx\n\n只输出数据，不要解释。` },
    { role: 'user', content: `用户需求：${userRequirement}\n\n目标层级路径：${layerPath}\n\nHTML：\n${segment}\n\n提取这个范围内新出现的数据！` }
  ];
  
  let result = await callLLM(messages);
  return await deduplicateData(result, '', sendProgress);
}

// 生成CSS选择器及相关配置 - 新方案：基于DOM路径
async function generateSelector(layerPath, userRequirement, extractedData, htmlSegment, sendProgress, tabId) {
  sendProgress(`🔍 开始精确选择器生成...`);
  
  // 第一步：解析已提取的数据
  const dataLines = extractedData.split('\n').filter(l => l.trim());
  const dataValues = dataLines.map(line => {
    const match = line.match(/:\s*(.+)$/);
    return match ? match[1].trim() : line.trim();
  }).filter(v => v.length > 0);
  
  sendProgress(`📊 解析到 ${dataValues.length} 条数据`);
  
  if (dataValues.length === 0) {
    sendProgress(`⚠️ 无有效数据，回退到LLM分析`);
    return await generateSelectorByLLM(layerPath, userRequirement, extractedData, htmlSegment, sendProgress);
  }
  
  // 第二步：在DOM中查找这些数据对应的元素路径
  sendProgress(`🔎 在DOM中定位元素路径...`);
  
  // 截取前10条数据进行路径分析
  const sampleData = dataValues.slice(0, 10);
  
  const elementPaths = [];
  for (const value of sampleData) {
    const result = await sendMessageToContent(tabId, {
      action: 'findElementPath',
      text: value,
      maxLength: 30
    });
    
    if (result && result.path) {
      elementPaths.push({
        text: value.substring(0, 30),
        path: result.path,
        tag: result.tag,
        id: result.id,
        className: result.className,
        attributes: result.attributes || {}
      });
    }
  }
  
  sendProgress(`✅ 定位到 ${elementPaths.length} 个元素路径`);
  
  if (elementPaths.length === 0) {
    sendProgress(`⚠️ DOM定位失败，回退到LLM分析`);
    return await generateSelectorByLLM(layerPath, userRequirement, extractedData, htmlSegment, sendProgress);
  }
  
  // 第三步：分析公共路径，生成最佳选择器
  sendProgress(`📋 分析公共路径和候选选择器...`);
  
  const candidates = [];
  const isImage = userRequirement.includes('图片') || userRequirement.includes('img') || userRequirement.includes('photo');
  
  // 策略1：ID选择器
  const ids = elementPaths.filter(e => e.id).map(e => `#${e.id}`);
  if (ids.length > 0) {
    candidates.push({ selector: ids[0], type: 'id', count: ids.length });
  }
  
  // 策略2：提取元素路径中的所有class，生成更灵活的候选
  const allClasses = [];
  const allTags = [];
  
  for (const e of elementPaths) {
    // 从 className 提取
    if (e.className) {
      const classes = e.className.split(/\s+/).filter(c => c && c.length < 50);
      allClasses.push(...classes);
    }
    
    // 从 path 提取 class（如 body > div.main > img.pic 格式）
    if (e.path) {
      const pathClasses = e.path.match(/\.([\w-]+)/g) || [];
      for (const c of pathClasses) {
        allClasses.push(c.substring(1));
      }
      
      // 提取 tag
      const tags = e.path.match(/>\s*([a-z][\w-]*)/gi) || [];
      for (const t of tags) {
        const tag = t.replace(/[>\s]/g, '').toLowerCase();
        if (tag && tag.length < 20) allTags.push(tag);
      }
    }
    
    // 从 attributes 提取
    for (const [key, val] of Object.entries(e.attributes || {})) {
      if (key.startsWith('data-') && val) {
        allClasses.push(val);
      }
    }
  }
  
  // 过滤掉无意义的 class（浏览器内核、UA 相关）
  const uniqueClasses = [...new Set(allClasses)];
  const filteredClasses = uniqueClasses.filter(cls => {
    const lower = cls.toLowerCase();
    // 排除浏览器相关的 class
    if (/^(ks-|webkit|chrome|firefox|safari|gecko|trident|edge|presto|blink|version|browser|os|platform|device|mobile|desktop)/.test(lower)) {
      return false;
    }
    // 排除包含数字过多或太长的
    if (cls.length > 30 || (cls.length > 15 && /\d{3,}/.test(cls))) {
      return false;
    }
    // 排除纯数字或随机 hash
    if (/^[0-9]+$/.test(cls) || /^[a-f0-9]{20,}$/i.test(cls)) {
      return false;
    }
    return cls.length > 2;
  });
  
  const uniqueFilteredClasses = [...new Set(filteredClasses)];
  sendProgress(`📋 提取到 ${uniqueFilteredClasses.length} 个有效候选class: ${uniqueFilteredClasses.slice(0, 5).join(', ')}...`);
  
  // 生成 class 选择器候选
  for (const cls of uniqueFilteredClasses) {
    candidates.push({ selector: `.${cls}`, type: 'class', count: 1 });
  }
  
  // 生成 tag 选择器候选（如果是图片）
  if (isImage) {
    const imgClasses = filteredClasses.filter(c => /pic|img|photo|origin|main/i.test(c));
    for (const cls of imgClasses) {
      candidates.push({ selector: `img.${cls}`, type: 'img-class', count: 1 });
    }
    candidates.push({ selector: 'img', type: 'img-tag', count: 1 });
  }
  
  // 策略3：完整路径选择器（去除了 nth-of-type 的简化版）
  const simplifiedPaths = elementPaths.map(p => {
    return p.path.replace(/:nth-of-type\(\d+\)/g, '');
  });
  const commonSimplifiedPath = findCommonPath(simplifiedPaths);
  if (commonSimplifiedPath) {
    candidates.push({ selector: commonSimplifiedPath, type: 'simplified-path', count: 1 });
  }
  
  // 策略4：基于层级路径生成选择器
  if (layerPath) {
    candidates.push({ selector: layerPath, type: 'layer-path', count: 1 });
    // 如果是图片，添加层级+img
    if (isImage) {
      candidates.push({ selector: `${layerPath} img`, type: 'layer-img', count: 1 });
    }
  }
  
  // 去重候选
  const seen = new Set();
  const uniqueCandidates = candidates.filter(c => {
    if (seen.has(c.selector)) return false;
    seen.add(c.selector);
    return true;
  });
  
  sendProgress(`📋 生成 ${uniqueCandidates.length} 个候选选择器`);
  
  // 第四步：验证每个候选选择器
  sendProgress(`🔬 验证 ${uniqueCandidates.length} 个候选选择器...`);
  
  const validatedCandidates = [];
  for (const candidate of uniqueCandidates) {
    const result = await sendMessageToContent(tabId, {
      action: 'validateSelector',
      selector: candidate.selector
    });
    
    if (result && result.valid) {
      const accuracy = calculateAccuracy(result.count, dataValues.length);
      validatedCandidates.push({
        ...candidate,
        matchCount: result.count,
        accuracy: accuracy,
        samples: result.samples || []
      });
      sendProgress(`  - ${candidate.selector}: 匹配${result.count}次, 准确度${accuracy}%`);
    }
  }
  
  if (validatedCandidates.length === 0) {
    sendProgress(`⚠️ 候选选择器验证失败，回退到LLM`);
    return await generateSelectorByLLM(layerPath, userRequirement, extractedData, htmlSegment, sendProgress);
  }
  
  // 第五步：排序选择最佳
  // 对于图片提取，优先选择匹配数量多的选择器（能提取更多数据）
  if (isImage) {
    validatedCandidates.sort((a, b) => {
      // 优先 matchCount 多的
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      // 其次 accuracy 高的
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      // 选择器更具体的优先（长度更长）
      return b.selector.length - a.selector.length;
    });
  } else {
    // 非图片：按准确度优先
    validatedCandidates.sort((a, b) => {
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      return b.count - a.count;
    });
  }
  
  const best = validatedCandidates[0];
  sendProgress(`✅ 最佳选择器: ${best.selector} (匹配${best.matchCount}次, 准确度${best.accuracy}%)`);
  
  // 第六步：分析懒加载属性和过滤模式
  sendProgress(`🔍 分析懒加载模式和噪音过滤...`);
  
  const analyzeResult = await analyzeLazyAndFilter(tabId, best.selector, userRequirement, sendProgress);
  
  globalLazyAttr = analyzeResult.lazyAttr;
  globalFilterPatterns = analyzeResult.filterPatterns;
  
  sendProgress(`📋 懒加载属性: ${globalLazyAttr}`);
  sendProgress(`📋 过滤模式: ${globalFilterPatterns.join(', ')}`);
  
  return best.selector;
}

// 分析class模式，找出公共class组合
function analyzeClassPatterns(elementPaths) {
  const patterns = [];
  
  // 提取所有class列表
  const classLists = elementPaths.map(e => {
    if (e.className) {
      return e.className.split(/\s+/).filter(c => c && c.length < 30);
    }
    return [];
  });
  
  // 找出所有路径中的class
  const pathClasses = elementPaths.map(e => {
    const match = e.path.match(/class="([^"]+)"/g) || [];
    return match.map(m => m.match(/class="([^"]+)"/)?.[1]).filter(Boolean);
  }).flat();
  
  // 生成多种class组合
  const allClasses = [...new Set(pathClasses)];
  if (allClasses.length > 0) {
    // 单class选择器
    for (const cls of allClasses) {
      patterns.push({ selector: `.${cls}`, type: 'class', count: pathClasses.filter(c => c === cls).length });
    }
    
    // 双class组合
    for (let i = 0; i < allClasses.length; i++) {
      for (let j = i + 1; j < allClasses.length; j++) {
        patterns.push({
          selector: `.${allClasses[i]}.${allClasses[j]}`,
          type: 'class-combination',
          count: pathClasses.filter(c => c === allClasses[i] || c === allClasses[j]).length
        });
      }
    }
  }
  
  // 从完整路径提取class模式
  for (const e of elementPaths) {
    const pathMatch = e.path.match(/[\w-]+\.[\w-.]+/g);
    if (pathMatch) {
      for (const match of pathMatch) {
        const classes = match.split('.').filter(c => c && !c.match(/^\d/));
        if (classes.length >= 1) {
          const selector = '.' + classes.join('.');
          if (!patterns.some(p => p.selector === selector)) {
            patterns.push({ selector, type: 'path-class', count: 1 });
          }
        }
      }
    }
  }
  
  return patterns;
}

// 找出公共路径
function findCommonPath(paths) {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  
  const parts = paths[0].split(' > ');
  let commonParts = [parts[0]];
  
  for (let i = 1; i < parts.length; i++) {
    const nextParts = paths.map(p => p.split(' > ')[i]).filter(Boolean);
    if (nextParts.every(p => p === nextParts[0])) {
      commonParts.push(nextParts[0]);
    } else {
      break;
    }
  }
  
  if (commonParts.length >= 2) {
    return commonParts.join(' > ');
  }
  
  return null;
}

// 计算准确度
function calculateAccuracy(matchCount, expectedCount) {
  if (matchCount === 0) return 0;
  if (matchCount === expectedCount) return 100;
  
  const ratio = Math.min(matchCount, expectedCount) / Math.max(matchCount, expectedCount);
  return Math.round(ratio * 100);
}

// 分析懒加载属性和过滤模式
async function analyzeLazyAndFilter(tabId, selector, userRequirement, sendProgress) {
  const isImage = userRequirement.includes('图片') || userRequirement.includes('img') || userRequirement.includes('photo');
  
  if (!isImage) {
    return { lazyAttr: 'src', filterPatterns: [] };
  }
  
  const result = await sendMessageToContent(tabId, {
    action: 'findElements',
    selector: selector
  });
  
  if (!result || !result.elements || result.elements.length === 0) {
    return { lazyAttr: 'src', filterPatterns: ['tps-', 'badge', 'icon', 'label'] };
  }
  
  const elements = result.elements.slice(0, 5);
  
  // 分析懒加载属性
  const attrCounts = {};
  for (const el of elements) {
    for (const [key] of Object.entries(el.attributes || {})) {
      attrCounts[key] = (attrCounts[key] || 0) + 1;
    }
  }
  
  const sortedAttrs = Object.entries(attrCounts).sort((a, b) => b[1] - a[1]);
  const likelyLazyAttr = sortedAttrs.find(([key]) => 
    ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'srcset', 'data-url'].includes(key)
  )?.[0] || 'src';
  
  // 过滤模式
  const filterPatterns = ['tps-', 'badge', 'icon', 'label', '!!600000000'];
  
  return {
    lazyAttr: likelyLazyAttr,
    filterPatterns: filterPatterns
  };
}

// 回退到LLM分析
async function generateSelectorByLLM(layerPath, userRequirement, extractedData, htmlSegment, sendProgress) {
  sendProgress(`🤖 回退到LLM分析...`);
  
  const messages = [
    { role: 'system', content: `你是一个网页数据提取专家。分析HTML片段，找出包含目标数据的最佳选择器。

输出格式（必须严格按此JSON格式）：
{
  "selector": "CSS选择器",
  "lazyAttr": "懒加载属性名",
  "filterPatterns": ["需要过滤的URL关键词数组"],
  "reason": "简要说明"
}

重要：
1. 选择器必须精确指向目标元素
2. 如果是图片，找出真实URL所在属性
3. 输出必须是合法JSON` },
    { role: 'user', content: `用户需求：${userRequirement}
层级路径：${layerPath}
HTML片段：${htmlSegment.substring(0, 8000)}
已提取数据：${extractedData.substring(0, 1000)}` }
  ];
  
  try {
    const rawResult = await callLLM(messages);
    const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const info = JSON.parse(jsonMatch[0]);
      globalLazyAttr = info.lazyAttr || 'src';
      globalFilterPatterns = info.filterPatterns || ['tps-', 'badge', 'icon'];
      sendProgress(`📋 LLM分析: 选择器=${info.selector}, 懒加载=${globalLazyAttr}`);
      return info.selector || '';
    }
  } catch (e) {
    sendProgress(`⚠️ LLM分析失败: ${e.message}`);
  }
  
  return '';
}

// 发送消息到content script的辅助函数
function sendMessageToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      resolve(response);
    });
  });
}

// 使用选择器快速提取数据
async function extractBySelector(tabId, userRequirement, formatLabel, sendProgress) {
  if (!globalSelector) {
    return null;
  }
  
  sendProgress(`🔍 使用选择器快速提取: ${globalSelector}`);
  
  // 在content script中执行选择器，传递懒加载属性和过滤规则
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, {
      action: 'extractBySelector',
      selector: globalSelector,
      requirement: userRequirement,
      lazyAttr: globalLazyAttr,
      filterPatterns: globalFilterPatterns
    }, (response) => {
      if (response && response.data) {
        resolve(response.data);
      } else {
        resolve(null);
      }
    });
  });
}
