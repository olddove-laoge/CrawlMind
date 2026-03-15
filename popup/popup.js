// popup.js - UI交互逻辑

// 加载保存的API Key
chrome.storage.local.get(['apiKey'], (result) => {
  if (result.apiKey) {
    document.getElementById('apiKeyInput').value = result.apiKey;
  }
});

// 保存API Key
document.getElementById('saveApiKey').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  if (!apiKey) {
    alert('请输入API Key');
    return;
  }
  chrome.storage.local.set({ apiKey: apiKey }, () => {
    alert('API Key 已保存');
  });
});

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  // 发送分析请求
  chrome.runtime.sendMessage({ action: 'analyze' }, response => {
    console.log('Response:', response);
    if (!response || !response.treeText) {
      alert('分析失败，请刷新页面后重试');
      return;
    }
    document.getElementById('analysisResult').classList.remove('hidden');
    document.getElementById('fieldsList').textContent = response.treeText.substring(0, 20000);
  });
});

// 判断是否需要分析网页
function needsPageAnalysis(message) {
  const keywords = ['爬取', '抓取', '采集', '获取', '提取', '数据', '商品', '评论', '价格', '标题', '内容', '链接', '图片'];
  const casualWords = ['你是谁', '你好', 'hello', 'hi', '帮忙', '告诉', '介绍'];
  
  // 如果包含爬取相关关键词，需要分析页面
  return keywords.some(kw => message.includes(kw));
}

document.getElementById('sendBtn').addEventListener('click', async () => {
  const input = document.getElementById('userInput');
  const message = input.value.trim();
  if (!message) return;
  
  // 显示用户消息
  const messagesDiv = document.getElementById('chatMessages');
  messagesDiv.innerHTML += `<div class="user-msg">你: ${message}</div>`;
  messagesDiv.innerHTML += `<div class="ai-msg">AI: 正在思考...</div>`;
  input.value = '';
  
  thinkingSteps = [];
  addThinkingSection();
  
  const aiMsg = messagesDiv.querySelector('.ai-msg:last-child');
  const needAnalysis = needsPageAnalysis(message);
  
  if (needAnalysis) {
    // 需要分析网页
    aiMsg.textContent = 'AI: 正在分析页面结构...';
    currentAiMsg = aiMsg;
    
    chrome.runtime.sendMessage({ action: 'chat', message: message, treeText: '' }, response => {
      console.log('LLM响应:', response);
      aiMsg.textContent = 'AI: ' + response.result;
      currentAiMsg = null;
    });
  } else {
    // 闲聊模式
    aiMsg.textContent = 'AI: 对话中...';
    
    chrome.runtime.sendMessage({ action: 'chat', message: message, mode: 'casual' }, response => {
      console.log('LLM响应:', response);
      aiMsg.textContent = 'AI: ' + response.result;
    });
  }
});

// 辅助函数
function renderAnalysis(data) { /* TODO */ }
function renderChat(messages) { /* TODO */ }
function renderCode(code) { /* TODO */ }

// 监听进度消息
let currentAiMsg = null;
let thinkingSteps = [];

function updateThinkingDisplay() {
  const thinkingDiv = document.getElementById('thinkingProcess');
  if (thinkingDiv) {
    thinkingDiv.innerHTML = thinkingSteps.map((step, i) => 
      `<div class="thinking-step" data-index="${i}">${step}</div>`
    ).join('');
  }
}

function addThinkingSection() {
  const messagesDiv = document.getElementById('chatMessages');
  const existing = messagesDiv.querySelector('.thinking-section');
  if (existing) existing.remove();
  
  const section = document.createElement('div');
  section.className = 'thinking-section';
  section.innerHTML = `
    <div class="thinking-header" onclick="toggleThinking()">
      <span class="thinking-toggle">▶</span> 思考过程
    </div>
    <div class="thinking-content" id="thinkingProcess"></div>
  `;
  messagesDiv.appendChild(section);
  return section;
}

function toggleThinking() {
  const content = document.getElementById('thinkingProcess');
  const toggle = document.querySelector('.thinking-toggle');
  if (content.classList.contains('expanded')) {
    content.classList.remove('expanded');
    toggle.textContent = '▶';
  } else {
    content.classList.add('expanded');
    toggle.textContent = '▼';
  }
}
window.toggleThinking = toggleThinking;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Popup收到消息:', request);
  if (request.action === 'progress') {
    const msg = request.message;
    console.log('进度消息:', msg);
    if (msg.startsWith('💭')) {
      thinkingSteps.push(msg);
      updateThinkingDisplay();
      // 同时更新AI消息显示
      if (currentAiMsg) {
        currentAiMsg.textContent = 'AI: ' + msg;
      }
    } else if (currentAiMsg) {
      currentAiMsg.textContent = 'AI: ' + msg;
    }
  }
});
