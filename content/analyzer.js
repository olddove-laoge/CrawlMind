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

// 遍历DOM树，生成树形文本（仅框架结构）
function buildTree(element, depth = 0) {
  const indent = '  '.repeat(depth);
  const tagName = element.tagName.toLowerCase();
  
  const skipTags = ['script', 'style', 'meta', 'noscript'];
  if (skipTags.includes(tagName)) return '';
  
  const attrs = [];
  for (const attr of element.attributes) {
    if (attr.name === 'class' || attr.name === 'id' || 
        attr.name.startsWith('data-') || attr.name === 'role') {
      attrs.push(`${attr.name}="${attr.value}"`);
    }
  }
  
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
  
  const attrs = [];
  for (const attr of element.attributes) {
    if (attr.name === 'class' || attr.name === 'id' || 
        attr.name.startsWith('data-') || attr.name === 'role') {
      attrs.push(`${attr.name}="${attr.value}"`);
    }
  }
  
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
    <div id="crawlmind-settings" style="padding: 10px; border-bottom: 1px solid #eee; display: flex; gap: 8px;">
      <input type="text" id="crawlmind-apikey" placeholder="输入 DeepSeek API Key" 
        style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 6px;">
      <button id="crawlmind-save-apikey" style="padding: 8px 12px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">保存</button>
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
