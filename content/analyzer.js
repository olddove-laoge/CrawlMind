// content/analyzer.js - 网页分析器 + 浮窗UI

let chatPanel = null;
let isPanelOpen = false;

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
      }
    }, 100);
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
    </div>
  `;
  
  document.body.appendChild(chatPanel);
  
  // 绑定事件
  document.getElementById('crawlmind-close').onclick = togglePanel;
  document.getElementById('crawlmind-send').onclick = sendMessage;
  document.getElementById('crawlmind-save-apikey').onclick = saveApiKey;
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
