// background/background.js - 后台脚本

// 全局变量存储滚动容器和翻页按钮
let globalScrollContainers = [];
let globalPaginationButtons = [];
let globalUserRequirement = '';
let globalExtractedData = new Set(); // 已爬取的数据用于去重

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
  if (['findScrollable', 'findPagination', 'doScroll', 'doClickPagination'].includes(request.action)) {
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
    
    // 快速跳过非商品区域
    const skipKeywords = [];
    
    // 从上一次分析的层级位置继续
    while (offset < fullContent.length) {
      sendProgressToPage(`🔍 正在深度分析 (${loopCount})，范围: ${offset}-${offset + 20000}...`);
      
      let segment = fullContent.substring(offset, offset + 20000);
      if (!segment) break;
      
      messages[1].content = `用户需求：${userRequirement}\n\nHTML层级结构（深度${currentDepth + 1}，当前偏移${offset}）：\n${segment}\n\n请严格按照格式输出：\n---分析开始---\n[详细描述这个层级的结构，观察是否包含具体的商品列表/商品名称。注意：如果只是导航菜单、分类链接、筛选条件等，不是真正的商品列表]\n\n---判断结果---\n{"是否找到": true/false, "层级路径": "如 div.class", "包含的属性": "如 id='xxx'", "理由": "为什么选择"}`;
      
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
      
      // ====== 智能跳过非商品区域 ======
      let shouldSkip = false;
      for (let kw of skipKeywords) {
        if (layerPath.toLowerCase().includes(kw.toLowerCase()) || 
            loopAnalysisPart.toLowerCase().includes(kw.toLowerCase())) {
          sendProgressToPage(`⏭ 跳过非商品区域 (${kw}): ${layerPath}`);
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
          { role: 'system', content: `你是反思专家。之前选择的层级路径都没有找到真正的商品列表，你需要重新分析。

已尝试过的路径：${Array.from(triedLayers).join(', ')}

用户需求：${userRequirement}

你需要：
1. 重新分析HTML结构
2. 找出可能包含真正商品列表的位置（注意：商品列表通常在页面中后部，可能需要滚动加载）
3. 给出新的、更可能包含商品的层级路径

重要：商品列表通常不在导航、筛选、分类区域，而是在主内容区域！` },
          { role: 'user', content: `当前HTML片段（偏移${offset}）：
${segment}

请重新分析并给出一个新的、更可能包含商品列表的层级路径。格式：
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
1. 数据类型不对？例如：要的是商品名称，却提取了分类名称
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
          { role: 'system', content: `你是反思专家。用户明确拒绝了你提取的数据。

用户需求：${userRequirement}
之前的层级路径：${layerPath}
拒绝原因分析：${rejectReason}

已尝试过的路径：${Array.from(triedLayers).join(', ')}

你需要：
1. 根据拒绝原因，重新分析HTML结构
2. 找出真正包含用户所需数据的正确位置
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
  
  // 将已确认的数据加入全局去重集合
  const resultLines = result.split('\n').filter(l => l.trim());
  resultLines.forEach(line => globalExtractedData.add(line.trim().toLowerCase()));
  sendProgress(`🔄 已将 ${resultLines.length} 条数据加入去重集合`);
  
  // 继续获取更多数据 - 从第一次提取结束的位置开始
  sendProgress('📥 继续获取更多数据...');
  let moreResult = await getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, extractStart + firstExtractSize, tabId, sendProgress);
  
  return result + '\n\n' + moreResult;
}

// 根据层级继续获取更多数据
async function getMoreResultsByLayer(treeText, userRequirement, layerPath, formatLabel, startOffset, tabId, sendProgress) {
  let maxChars = 20000;
  let allData = '';
  let moreCount = 1;
  let lastPageUrl = '';
  
  // 使用已识别的格式标签
  let formatPrompt = `${formatLabel}N: xxx (每个数据单独一行)`;
  
  // 添加停止按钮
  chrome.tabs.sendMessage(tabId, { action: 'addStopButton' }).catch(() => {});
  
  // 获取初始页面URL
  try {
    const tab = await chrome.tabs.get(tabId);
    lastPageUrl = tab.url;
  } catch (e) {}
  
  while (startOffset < treeText.length) {
    // 检查用户是否点击停止
    const { stopExtract } = await chrome.storage.local.get('stopExtract');
    if (stopExtract) {
      sendProgress('⏹ 用户中断提取');
      await chrome.storage.local.set({ stopExtract: false });
      return allData;
    }
    
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
      // ====== 尝试滚动或翻页 ======
      sendProgress('⚠️ 当前页无更多数据，尝试滚动或翻页...');
      
      let foundNewData = false;
      
      // 1. 尝试滚动滚动容器
      if (globalScrollContainers.length > 0) {
        sendProgress(`📜 尝试滚动 ${globalScrollContainers.length} 个滚动容器...`);
        
        for (let i = 0; i < globalScrollContainers.length; i++) {
          const scrollResult = await chrome.tabs.sendMessage(tabId, { action: 'doScroll', index: i });
          if (scrollResult?.success) {
            sendProgress(`📜 已滚动容器 ${i + 1}，等待加载...`);
            await new Promise(r => setTimeout(r, 1500));
            
            const newFullTree = await getFullPageTree(tabId);
            if (newFullTree && newFullTree.length > treeText.length) {
              const newData = await extractNewData(newFullTree, treeText.length, userRequirement, layerPath, formatLabel, sendProgress);
              if (newData && newData.length > 0) {
                sendProgress(`📜 滚动后发现 ${newData.length} 个新数据`);
                allData += newData + '\n';
                treeText = newFullTree;
                foundNewData = true;
                break;
              }
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
            await new Promise(r => setTimeout(r, 2000));
            
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
              const newFullTree = await getFullPageTree(tabId);
              const newData = await extractNewData(newFullTree, 0, userRequirement, layerPath, formatLabel, sendProgress);
              
              if (newData && newData.length > 0) {
                sendProgress(`🔄 翻页后发现 ${newData.length} 个新数据`);
                allData += newData + '\n';
                treeText = newFullTree;
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
      allData += uniqueResult + '\n';
      const lines = uniqueResult.split('\n').filter(l => l.trim());
      lines.forEach(line => globalExtractedData.add(line.trim().toLowerCase()));
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
  
  // 1. 尝试滚动滚动容器
  if (globalScrollContainers.length > 0) {
    sendProgress(`📜 尝试滚动 ${globalScrollContainers.length} 个滚动容器...`);
    
    for (let i = 0; i < globalScrollContainers.length; i++) {
      const scrollResult = await chrome.tabs.sendMessage(tabId, { action: 'doScroll', index: i });
      if (scrollResult?.success) {
        sendProgress(`📜 已滚动容器 ${i + 1}，等待加载...`);
        await new Promise(r => setTimeout(r, 2000));
        
        const newFullTree = await getFullPageTree(tabId);
        if (newFullTree && newFullTree.length > treeText.length) {
          const newData = await extractNewData(newFullTree, treeText.length, userRequirement, layerPath, formatLabel, sendProgress);
          if (newData && newData.length > 0) {
            sendProgress(`📜 滚动后发现新数据，继续提取...`);
            allData += newData + '\n';
            treeText = newFullTree;
            startOffset = treeText.length;
            foundNewData = true;
            break;
          }
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
        await new Promise(r => setTimeout(r, 2000));
        
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
  const existingLines = existingData.split('\n').filter(l => l.trim());
  
  const existingSet = new Set(existingLines.map(l => l.trim().toLowerCase()));
  const globalSet = globalExtractedData;
  
  const uniqueLines = [];
  for (const line of newLines) {
    const trimmed = line.trim().toLowerCase();
    if (!existingSet.has(trimmed) && !globalSet.has(trimmed)) {
      uniqueLines.push(line.trim());
      globalSet.add(trimmed);
    }
  }
  
  if (uniqueLines.length < newLines.length) {
    sendProgress(`🔄 去重过滤了 ${newLines.length - uniqueLines.length} 个重复数据`);
  }
  
  return uniqueLines.join('\n');
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
