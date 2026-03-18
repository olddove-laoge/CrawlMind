// content/analyzer.js - 网页分析器 + 浮窗UI

let chatPanel = null;
let isPanelOpen = false;

// 遍历Shadow DOM的辅助函数
function traverseShadowDOM(hostElement, buildFunc, depth) {
  let result = '';
  if (hostElement.shadowRoot) {
    const shadowIndent = '  '.repeat(depth);
    result += `${shadowIndent}<#shadow-root>\n`;
    for (const child of hostElement.shadowRoot.children) {
      result += buildFunc(child, depth + 1);
    }
  }
  return result;
}

// 需要提取的属性列表
const importantAttrs = [
  'class', 'id', 'role',
  'data-', 'aria-',
  'href', 'src', 'link'
];

function getImportantAttrs(element) {
  const attrs = [];
  for (const attr of element.attributes) {
    for (const important of importantAttrs) {
      if (attr.name === important || attr.name.startsWith(important)) {
        attrs.push(`${attr.name}="${attr.value}"`);
        break;
      }
    }
  }
  return attrs;
}

// 遍历DOM树，生成树形文本（仅框架结构）
function buildTree(element, depth = 0) {
  const indent = '  '.repeat(depth);
  const tagName = element.tagName.toLowerCase();
  
  const skipTags = ['script', 'style', 'meta', 'noscript'];
  if (skipTags.includes(tagName)) return '';
  
  const attrs = getImportantAttrs(element);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  let result = `${indent}<${tagName}${attrStr}>\n`;
  
  for (const child of element.children) {
    result += buildTree(child, depth + 1);
  }
  
  // 处理Shadow DOM
  result += traverseShadowDOM(element, buildTree, depth);
  
  return result;
}

// 遍历DOM树，生成完整HTML（包含文本内容）
function buildFullTree(element, depth = 0) {
  const indent = '  '.repeat(depth);
  const tagName = element.tagName.toLowerCase();
  
  const skipTags = ['script', 'style', 'meta', 'noscript'];
  if (skipTags.includes(tagName)) return '';
  
  const attrs = getImportantAttrs(element);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  const textContent = element.textContent.trim().substring(0, 200);
  const textPart = textContent ? ` [${textContent}]` : '';
  let result = `${indent}<${tagName}${attrStr}>${textPart}\n`;
  
  for (const child of element.children) {
    result += buildFullTree(child, depth + 1);
  }
  
  // 处理Shadow DOM
  result += traverseShadowDOM(element, buildFullTree, depth);
  
  return result;
}

// ==================== 滚动容器和翻页检测 ====================

// 滚动容器检测
function findScrollableContainers() {
  const containers = [];
  const allElements = document.querySelectorAll('*');
  
  for (const el of allElements) {
    try {
      const style = window.getComputedStyle(el);
      const overflow = style.overflow;
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      
      const isScrollable = 
        overflow === 'auto' || overflow === 'scroll' ||
        overflowY === 'auto' || overflowY === 'scroll' ||
        overflowX === 'auto' || overflowX === 'scroll';
      
      if (isScrollable && el.scrollHeight > el.clientHeight) {
        const rect = el.getBoundingClientRect();
        containers.push({
          element: el,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          class: el.className || '',
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        });
      }
    } catch (e) {}
  }
  
  return containers.sort((a, b) => b.rect.height - a.rect.height).slice(0, 20);
}

// 翻页检测 - 硬编码初筛 + LLM进一步判断
function findPaginationCandidates() {
  const candidates = [];
  
  // 1. 先用硬编码选择器快速初筛
  const selectors = [
    // 分页相关
    '.pagination a', '.pagination button', '.pager a', '.pager button',
    '.page-item a', '.page-item button',
    '[class*="pagination"] a', '[class*="pagination"] button',
    '[class*="pager"] a', '[class*="pager"] button',
    '[id*="pagination"] a', '[id*="pagination"] button',
    // 下一页/更多
    'a.next', 'a[class*="next"]', 'button.next', 'button[class*="next"]',
    'a.more', 'a[class*="more"]', 'button.more', 'button[class*="more"]',
    'a.load-more', 'button.load-more',
    // 页码
    'a[href*="page"]', 'a[href*="p="]',
    // 数字页码
    '.page a', '.page-num a', '[class*="page-num"] a'
  ];
  
  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        
        const text = el.textContent.trim();
        if (!text) continue;
        
        candidates.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          class: el.className || '',
          text: text.substring(0, 50),
          href: el.href || ''
        });
      }
    } catch (e) {}
  }
  
  // 2. 再从后往前补充一些底部元素作为候选
  const allElements = Array.from(document.querySelectorAll('*'));
  let补充 = 0;
  for (let i = allElements.length - 1; i >= 0; i--) {
    if (candidates.length >= 50 || 补充 >= 20) break;
    
    const el = allElements[i];
    const rect = el.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 20) continue;
    
    const tag = el.tagName.toLowerCase();
    if (tag !== 'a' && tag !== 'button') continue;
    
    const text = el.textContent.trim();
    if (text.length < 1 || text.length > 20) continue;
    
    // 检查是否已存在
    const exists = candidates.some(c => c.text === text);
    if (!exists) {
      candidates.push({
        tag: tag,
        id: el.id || '',
        class: el.className || '',
        text: text.substring(0, 50),
        href: el.href || ''
      });
      补充++;
    }
  }
  
  // 去重
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.tag + '|' + c.text.substring(0, 20);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }
  
  return unique.slice(0, 50);
}

// 尝试滚动容器
function scrollContainer(el) {
  el.scrollTop = el.scrollHeight;
  return true;
}

// 尝试点击翻页按钮
function clickPagination(el) {
  el.click();
  return true;
}

const treeText = buildTree(document.body);
const fullTreeText = buildFullTree(document.body);

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('收到消息:', request);
  if (request.action === 'analyze') {
    sendResponse({ treeText: treeText });
  }
  if (request.action === 'getTree') {
    // 框架结构（仅用于层级分析）
    const newTree = buildTree(document.body);
    sendResponse({ treeText: newTree });
  }
  if (request.action === 'getFullTree') {
    // 完整内容（用于数据提取）
    const fullTree = buildFullTree(document.body);
    sendResponse({ treeText: fullTree });
  }
  if (request.action === 'getBothTrees') {
    // 返回两个版本
    sendResponse({ 
      treeText: buildTree(document.body),
      fullTreeText: buildFullTree(document.body)
    });
  }
  if (request.action === 'progress') {
    // 显示进度消息，自动打开浮窗
    console.log('收到进度消息:', request.message);
    if (!isPanelOpen) {
      togglePanel();
    }
    // 等待浮窗创建完成
    setTimeout(() => {
      const container = document.getElementById('crawlmind-messages');
      if (container) {
        const div = document.createElement('div');
        div.style.cssText = 'padding: 8px 12px; margin: 5px 0; border-radius: 8px; font-size: 13px; background: #fff3cd; color: #856404;';
        div.textContent = request.message;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        
        // 如果提取完成或中断，恢复按钮状态
        if (request.message.includes('已获取所有数据') || request.message.includes('用户中断') || request.message.includes('已达最大') || request.message.includes('提取完成')) {
          document.getElementById('crawlmind-stop').style.display = 'none';
          document.getElementById('crawlmind-send').style.display = 'block';
        }
      }
    }, 100);
  }
  
  // 添加停止按钮
  if (request.action === 'addStopButton') {
    addStopButton();
  }
  
  // 用户确认请求
  if (request.action === 'requestUserConfirm') {
    showUserConfirmDialog(request.data, request.requirement, sendResponse);
    return true; // 异步响应
  }
  
  // 滚动容器检测
  if (request.action === 'findScrollable') {
    const containers = findScrollableContainers();
    sendResponse({ containers: containers });
  }
  
  // 翻页候选元素检测（由LLM判断）
  if (request.action === 'findPagination') {
    const candidates = findPaginationCandidates();
    sendResponse({ candidates: candidates });
  }
  
  // 滚动容器
  if (request.action === 'doScroll') {
    const { index } = request;
    const containers = findScrollableContainers();
    if (containers[index]) {
      scrollContainer(containers[index].element);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: '容器不存在' });
    }
  }
  
  // 点击翻页按钮
  if (request.action === 'doClickPagination') {
    const { index } = request;
    const pagination = findPaginationCandidates();
    // 需要重新获取元素才能点击
    const allLinks = document.querySelectorAll('a, button, [role="button"]');
    if (pagination[index]) {
      const text = pagination[index].text;
      for (const el of allLinks) {
        if (el.textContent.trim().substring(0, 50) === text) {
          clickPagination(el);
          sendResponse({ success: true });
          return true;
        }
      }
    }
    sendResponse({ success: false, error: '按钮不存在' });
  }
  
  return true;
});

// 创建浮窗UI
function createFloatingButton() {
  if (document.getElementById('crawlmind-float-btn')) return;
  
  const btn = document.createElement('div');
  btn.id = 'crawlmind-float-btn';
  btn.innerHTML = '🤖';
  btn.title = 'CrawlMind AI 爬虫';
  btn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 50px;
    height: 50px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    z-index: 2147483647;
    transition: transform 0.2s, box-shadow 0.2s;
  `;
  btn.onmouseenter = () => { btn.style.transform = 'scale(1.1)'; };
  btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; };
  btn.onclick = togglePanel;
  document.body.appendChild(btn);
}

function createChatPanel() {
  if (document.getElementById('crawlmind-panel')) return;
  
  chatPanel = document.createElement('div');
  chatPanel.id = 'crawlmind-panel';
  chatPanel.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 380px;
    height: 500px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 5px 30px rgba(0,0,0,0.2);
    z-index: 2147483647;
    display: none;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
  `;
  
  chatPanel.innerHTML = `
    <div style="padding: 12px 15px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; display: flex; justify-content: space-between; align-items: center;">
      <span style="font-weight: 600;">CrawlMind AI</span>
      <span id="crawlmind-close" style="cursor: pointer; font-size: 18px;">×</span>
    </div>
    <div id="crawlmind-settings" style="padding: 10px; border-bottom: 1px solid #eee; display: flex; gap: 8px; flex-wrap: wrap;">
      <input type="text" id="crawlmind-apikey" placeholder="输入 DeepSeek API Key" 
        style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 6px; min-width: 150px;">
      <button id="crawlmind-save-apikey" style="padding: 8px 12px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">保存</button>
      <button id="crawlmind-test-scroll" style="padding: 8px 12px; background: #2196F3; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">测试滚动/翻页</button>
    </div>
    <div id="crawlmind-test-result" style="padding: 10px; border-bottom: 1px solid #eee; max-height: 150px; overflow-y: auto; background: #f9f9f9; font-size: 12px; display: none;">
    </div>
    <div id="crawlmind-messages" style="flex: 1; overflow-y: auto; padding: 10px; background: #f5f5f5;">
    </div>
    <div style="padding: 10px; border-top: 1px solid #eee; display: flex; gap: 8px;">
      <input type="text" id="crawlmind-input" placeholder="请描述要爬取的数据..." 
        style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 20px; outline: none;">
      <button id="crawlmind-send" style="padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 20px; cursor: pointer;">发送</button>
      <button id="crawlmind-stop" style="padding: 8px 12px; background: #f44336; color: white; border: none; border-radius: 20px; cursor: pointer; display: none;">停止</button>
    </div>
  `;
  
  document.body.appendChild(chatPanel);
  
  // 绑定事件
  document.getElementById('crawlmind-close').onclick = togglePanel;
  document.getElementById('crawlmind-send').onclick = sendMessage;
  document.getElementById('crawlmind-save-apikey').onclick = saveApiKey;
  document.getElementById('crawlmind-stop').onclick = stopExtract;
  document.getElementById('crawlmind-test-scroll').onclick = testScrollAndPagination;
  document.getElementById('crawlmind-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };
  
  // 加载保存的 API Key
  chrome.storage.local.get(['apiKey'], (result) => {
    if (result.apiKey) {
      document.getElementById('crawlmind-apikey').value = result.apiKey;
    }
  });
}

function togglePanel() {
  if (!chatPanel) createChatPanel();
  
  isPanelOpen = !isPanelOpen;
  chatPanel.style.display = isPanelOpen ? 'flex' : 'none';
  
  if (isPanelOpen && !document.getElementById('crawlmind-apikey').value) {
    addMessage('system', '请先输入 DeepSeek API Key');
  }
}

function addMessage(type, content) {
  const container = document.getElementById('crawlmind-messages');
  const div = document.createElement('div');
  div.style.cssText = `
    padding: 8px 12px;
    margin: 5px 0;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
    ${type === 'user' ? 'background: #667eea; color: white; margin-left: 20px;' : 'background: white; margin-right: 20px;'}
  `;
  div.textContent = content;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function saveApiKey() {
  const apikeyInput = document.getElementById('crawlmind-apikey');
  const apiKey = apikeyInput.value.trim();
  if (apiKey) {
    chrome.storage.local.set({ apiKey: apiKey }, () => {
      addMessage('system', '✅ API Key 已保存');
    });
  } else {
    addMessage('system', '请先输入 API Key');
  }
}

function stopExtract() {
  chrome.storage.local.set({ stopExtract: true }, () => {
    addMessage('system', '⏹ 已发送停止信号...');
  });
}

// 测试滚动容器和翻页按钮检测
function testScrollAndPagination() {
  const resultDiv = document.getElementById('crawlmind-test-result');
  resultDiv.style.display = 'block';
  resultDiv.innerHTML = '<div style="color: #666;">🔍 正在检测...</div>';
  
  // 检测滚动容器
  chrome.runtime.sendMessage({ action: 'findScrollable' }, (response) => {
    const containers = response?.containers || [];
    
    // 获取翻页候选元素
    chrome.runtime.sendMessage({ action: 'findPagination' }, (resp2) => {
      const candidates = resp2?.candidates || [];
      
      // 调试信息
      console.log('候选元素数量:', candidates.length);
      
      // 显示所有候选元素（用于调试）
      let debugHtml = `<div style="margin:5px; padding:5px; background:#f0f0f0; font-size:11px;">调试: 候选元素${candidates.length}个</div>`;
      
      if (candidates.length > 0) {
        debugHtml += '<div style="font-size:10px; max-height:100px; overflow:auto;">';
        candidates.slice(0, 10).forEach((c, i) => {
          debugHtml += `<div>[${i}] &lt;${c.tag}&gt; "${c.text.substring(0,30)}"</div>`;
        });
        debugHtml += '</div>';
      }
      
      resultDiv.innerHTML = debugHtml + '<div style="color:#666;">🤖 LLM分析中...</div>';
      
      // 让LLM判断哪些是翻页按钮
      chrome.runtime.sendMessage({ action: 'analyzePaginationCandidates', candidates: candidates }, (resp3) => {
        const llmResult = resp3?.result || '';
        const llmError = resp3?.error || '';
        
        console.log('LLM返回:', llmResult);
        resultDiv.innerHTML = debugHtml + `<div style="margin:5px; padding:5px; background:#e0e0ff; font-size:11px;">LLM返回: ${llmResult || llmError}</div>`;
        
        // 解析LLM返回的索引
        const paginationIndices = [];
        if (llmResult && llmResult !== '无' && llmResult !== 'none') {
          const matches = llmResult.match(/[\d,]+/g);
          if (matches) {
            matches[0].split(',').forEach(i => {
              const idx = parseInt(i.trim());
              if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
                paginationIndices.push(idx);
              }
            });
          }
        }
        
        // 根据索引获取翻页按钮
        const pagination = paginationIndices.map(i => candidates[i]).filter(Boolean);
        
        let html = '<div style="margin-bottom: 10px;"><strong>📜 滚动容器 (点击滚动):</strong></div>';
        
        if (containers.length === 0) {
          html += '<div style="color: #999; margin-bottom: 10px;">未找到可滚动容器</div>';
        } else {
          containers.forEach((c, i) => {
            html += `<div id="scroll-item-${i}" style="margin: 5px 0; padding: 5px; background: #e3f2fd; border-radius: 4px; cursor: pointer;">
              [${i + 1}] &lt;${c.tag}&gt; #${c.id || '无ID'} .${c.class.substring(0, 20) || '无class'} 
              (${Math.round(c.rect.width)}x${Math.round(c.rect.height)} 可滚动: ${c.scrollHeight - c.clientHeight}px)
            </div>`;
          });
        }
        
        html += '<div style="margin: 10px 0;"><strong>🔄 翻页按钮 (LLM判断):</strong></div>';
        
        if (pagination.length === 0) {
          html += '<div style="color: #999;">未找到翻页按钮</div>';
        } else {
          pagination.forEach((p, i) => {
            html += `<div id="page-item-${i}" style="margin: 5px 0; padding: 5px; background: #fff3e0; border-radius: 4px; cursor: pointer;">
              [${i + 1}] &lt;${p.tag}&gt; "${p.text}" 
              ${p.href ? '(' + p.href.substring(0, 30) + '...)' : ''}
            </div>`;
          });
        }
        
        resultDiv.innerHTML = html;
        
        // 绑定滚动点击事件
        containers.forEach((c, i) => {
          document.getElementById('scroll-item-' + i).addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'doScroll', index: i }, (r) => {
              if (r?.success) {
                alert('✅ 已滚动');
              } else {
                alert('❌ 滚动失败: ' + (r?.error || '未知错误'));
              }
            });
          });
        });
        
        // 绑定翻页点击事件
        pagination.forEach((p, i) => {
          document.getElementById('page-item-' + i).addEventListener('click', () => {
            let clicked = false;
            
            // 方式1：尝试用选择器直接获取
            const selectors = [
              `button:contains('${p.text}')`,
              `a:contains('${p.text}')`,
              `button:contains('下一页')`,
              `button:contains('更多')`,
              `a:contains('下一页')`,
              `a:contains('更多')`
            ];
            
            // 方式2：遍历所有button和a
            const allClickable = document.querySelectorAll('button, a, [role="button"]');
            for (const el of allClickable) {
              const elText = el.textContent.trim();
              if (elText.includes('下一页') || elText.includes('更多') || elText.includes(p.text)) {
                console.log('点击元素:', el.tagName, elText);
                el.click();
                clicked = true;
                break;
              }
            }
            
            if (clicked) {
              console.log('✅ 已点击翻页，2秒后重新检测...');
              setTimeout(testScrollAndPagination, 2000);
            } else {
              console.log('❌ 找不到翻页按钮');
            }
          });
        });
      });
    });
  });
}

// 显示用户确认对话框
function showUserConfirmDialog(data, requirement, sendResponse) {
  const container = document.getElementById('crawlmind-messages');
  if (!container) {
    sendResponse({ confirmed: false });
    return;
  }
  
  // 确保面板打开
  if (!isPanelOpen) {
    togglePanel();
  }
  
  // 移除已有的确认对话框
  const existing = container.querySelector('.confirm-dialog');
  if (existing) existing.remove();
  
  // 显示提取的数据预览
  const dataPreview = document.createElement('div');
  dataPreview.className = 'confirm-dialog';
  dataPreview.style.cssText = 'padding: 12px; margin: 8px 0; background: #e3f2fd; border-radius: 8px; font-size: 13px; max-height: 200px; overflow-y: auto;';
  dataPreview.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 8px;">📋 请确认这是您要的数据</div>
    <div style="color: #666; margin-bottom: 8px;">需求: ${requirement}</div>
    <div style="background: white; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-all;">${data}</div>
    <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;">
      <button id="crawlmind-confirm-yes" style="padding: 8px 20px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">✅ 正确</button>
      <button id="crawlmind-confirm-no" style="padding: 8px 20px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">❌ 不对</button>
    </div>
  `;
  container.appendChild(dataPreview);
  container.scrollTop = container.scrollHeight;
  
  // 绑定确认按钮
  document.getElementById('crawlmind-confirm-yes').onclick = () => {
    chrome.storage.local.set({ userConfirmed: true }, () => {
      addMessage('system', '✅ 用户确认数据正确');
      dataPreview.remove();
      sendResponse({ confirmed: true });
    });
  };
  
  // 绑定拒绝按钮
  document.getElementById('crawlmind-confirm-no').onclick = () => {
    chrome.storage.local.set({ userConfirmed: false }, () => {
      addMessage('system', '❌ 用户拒绝该数据，将重新寻找');
      dataPreview.remove();
      sendResponse({ confirmed: false });
    });
  };
}

// 添加停止按钮到消息区域
function addStopButton() {
  const container = document.getElementById('crawlmind-messages');
  if (!container) return;
  
  // 移除已有的停止按钮
  const existing = container.querySelector('.stop-btn-container');
  if (existing) existing.remove();
  
  const div = document.createElement('div');
  div.className = 'stop-btn-container';
  div.style.cssText = 'padding: 10px; text-align: center;';
  div.innerHTML = `<button id="crawlmind-stop-batch" style="padding: 8px 24px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">⏹ 停止爬取</button>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  
  document.getElementById('crawlmind-stop-batch').onclick = () => {
    chrome.storage.local.set({ stopExtract: true });
    addMessage('system', '⏹ 已停止爬取');
    // 移除按钮
    div.remove();
  };
}

function sendMessage() {
  const input = document.getElementById('crawlmind-input');
  const apikeyInput = document.getElementById('crawlmind-apikey');
  const message = input.value.trim();
  
  // 保存 API Key
  const apiKey = apikeyInput.value.trim();
  if (apiKey) {
    chrome.storage.local.set({ apiKey: apiKey });
  }
  
  if (!message) return;
  if (!apiKey) {
    addMessage('system', '请先输入 DeepSeek API Key');
    return;
  }
  
  addMessage('user', message);
  input.value = '';
  
  // 重置停止标志
  chrome.storage.local.set({ stopExtract: false });
  
  // 判断是否需要分析页面
  const keywords = ['爬取', '抓取', '采集', '获取', '提取', '数据', '商品', '评论', '价格', '标题', '内容', '链接', '图片'];
  const needAnalysis = keywords.some(kw => message.includes(kw));
  
  if (needAnalysis) {
    addMessage('system', '正在分析页面结构...');
    
    chrome.runtime.sendMessage({ 
      action: 'chat', 
      message: message,
      treeText: treeText 
    }, (response) => {
      if (chrome.runtime.lastError) {
        addMessage('system', '错误: ' + chrome.runtime.lastError.message);
        return;
      }
      addMessage('system', response.result || '分析完成');
    });
  } else {
    addMessage('system', '正在思考...');
    
    chrome.runtime.sendMessage({ 
      action: 'chat', 
      message: message,
      mode: 'casual',
      treeText: treeText 
    }, (response) => {
      if (chrome.runtime.lastError) {
        addMessage('system', '错误: ' + chrome.runtime.lastError.message);
        return;
      }
      addMessage('system', response.result || '分析完成');
    });
  }
}

// 初始化浮窗
createFloatingButton();
