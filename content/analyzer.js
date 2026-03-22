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

// 持续滚动（模拟人类滚动）
async function smoothScrollContainer(el, stopSignal) {
  const scrollStep = 300;
  const scrollInterval = 50;
  const maxScrollTime = 60000; // 最多滚动60秒
  
  const startTime = Date.now();
  let lastScrollTop = el.scrollTop;
  let stableCount = 0;
  const stableThreshold = 5; // 连续5次滚动位置不变认为到底了
  
  return new Promise((resolve) => {
    const scroll = () => {
      // 检查停止信号
      if (stopSignal && stopSignal.current) {
        resolve({ success: true, reason: 'stopped' });
        return;
      }
      
      // 检查超时
      if (Date.now() - startTime > maxScrollTime) {
        resolve({ success: true, reason: 'timeout' });
        return;
      }
      
      const beforeScroll = el.scrollTop;
      el.scrollTop += scrollStep;
      
      // 触发滚动事件，让懒加载生效
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      
      // 检查是否还能继续滚动
      if (el.scrollTop === beforeScroll || el.scrollTop >= el.scrollHeight - el.clientHeight) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          resolve({ success: true, reason: 'bottom' });
          return;
        }
      } else {
        stableCount = 0;
      }
      
      lastScrollTop = el.scrollTop;
      
      // 随机延迟，模拟人类滚动
      const delay = scrollInterval + Math.random() * 30;
      setTimeout(scroll, delay);
    };
    
    scroll();
  });
}

// 检查容器是否已完全加载
function checkContainerLoaded(el, checkCount = 3) {
  return new Promise((resolve) => {
    let count = 0;
    let lastImgCount = 0;
    
    const check = () => {
      const imgs = el.querySelectorAll('img');
      const loadedImgs = Array.from(imgs).filter(img => {
        return img.complete && img.naturalWidth > 0;
      });
      
      if (loadedImgs.length === lastImgCount) {
        count++;
      } else {
        count = 0;
        lastImgCount = loadedImgs.length;
      }
      
      if (count >= checkCount) {
        resolve({ loaded: true, imgCount: loadedImgs.length });
      } else {
        setTimeout(check, 500);
      }
    };
    
    check();
  });
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
    console.log('收到进度消息:', request.message);
    if (!isPanelOpen) {
      togglePanel();
    }
    setTimeout(() => {
      const container = document.getElementById('crawlmind-messages');
      if (container) {
        const div = document.createElement('div');
        div.style.cssText = 'padding: 8px 12px; margin: 5px 0; border-radius: 8px; font-size: 13px; background: #fff3cd; color: #856404;';
        div.textContent = request.message;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        
        if (request.message.includes('已获取所有数据') || request.message.includes('用户中断') || request.message.includes('停止爬取')) {
          setExtractingState(false);
        }
      }
    }, 100);
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
    return true;
  }
  
  // 持续滚动（模拟人类）
  if (request.action === 'smoothScroll') {
    const { index, stopKey } = request;
    const containers = findScrollableContainers();
    
    if (!containers[index]) {
      sendResponse({ success: false, error: '容器不存在' });
      return true;
    }
    
    const container = containers[index].element;
    const stopSignal = { current: false };
    
    // 存储停止信号，供 background 访问
    window.__crawlmind_stopScroll = stopSignal;
    
    // 监听停止信号
    const checkStop = setInterval(() => {
      chrome.storage.local.get(stopKey, (result) => {
        if (result[stopKey]) {
          stopSignal.current = true;
          clearInterval(checkStop);
        }
      });
    }, 100);
    
    smoothScrollContainer(container, stopSignal).then((result) => {
      clearInterval(checkStop);
      delete window.__crawlmind_stopScroll;
      sendResponse({ success: true, ...result });
    });
    
    return true;
  }
  
  // 点击翻页按钮
  if (request.action === 'doClickPagination') {
    const { text } = request;
    console.log('CrawlMind: 收到翻页请求, text=', text);
    const allLinks = document.querySelectorAll('a, button, [role="button"]');
    console.log('CrawlMind: 总共找到', allLinks.length, '个可点击元素');
    
    // 打印所有 button 元素看看
    const allButtons = document.querySelectorAll('button');
    console.log('CrawlMind: button 数量:', allButtons.length);
    for (const btn of allButtons) {
      const tc = btn.textContent.trim();
      console.log('CrawlMind: button textContent:', tc, '| aria-label:', btn.getAttribute('aria-label'));
    }
    
    // 用 LLM 检测的文本去匹配
    if (text) {
      const targetText = text.toLowerCase();
      for (const el of allLinks) {
        // 跳过 javascript: 链接和空文本元素
        if (el.href && el.href.startsWith('javascript:')) continue;
        const elText = el.textContent.trim().toLowerCase();
        if (!elText) continue;
        if (elText.includes(targetText) || targetText.includes(elText)) {
          console.log('CrawlMind: 点击按钮, text=', el.textContent.trim());
          clickPagination(el);
          sendResponse({ success: true });
          return true;
        }
      }
    }
    
    // 如果 LLM 文本匹配不到，用 aria-label 匹配
    for (const el of allButtons) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      if (ariaLabel.includes('下一页')) {
        console.log('CrawlMind: 通过 aria-label 点击按钮:', ariaLabel);
        clickPagination(el);
        sendResponse({ success: true });
        return true;
      }
    }
    
    // 如果 LLM 文本匹配不到，用关键词兜底
    for (const el of allLinks) {
      // 跳过 javascript: 链接和空文本元素
      if (el.href && el.href.startsWith('javascript:')) continue;
      const elText = el.textContent.trim();
      if (!elText) continue;
      if (elText.includes('下一页') || elText.includes('Next') || elText.includes('更多') || elText.includes('加载更多')) {
        console.log('CrawlMind: 兜底点击按钮, text=', elText);
        clickPagination(el);
        sendResponse({ success: true });
        return true;
      }
    }
    
    console.log('CrawlMind: 没找到翻页按钮');
    sendResponse({ success: false, error: '按钮不存在' });
    return true;
  }
  
  // 根据文本查找元素路径
  if (request.action === 'findElementPath') {
    const result = findElementByText(request.text, request.maxLength || 50);
    sendResponse(result);
  }
  
  // 根据多个文本查找元素路径
  if (request.action === 'findMultipleElementPaths') {
    const results = findMultipleElementsByTexts(request.texts || []);
    sendResponse({ elements: results });
  }
  
  // 验证选择器
  if (request.action === 'validateSelector') {
    const result = validateSelectorOnPage(request.selector);
    sendResponse(result);
  }
  
  // 使用选择器查找元素
  if (request.action === 'findElements') {
    const elements = findElementsBySelector(request.selector);
    sendResponse({ elements: elements });
  }
  
  // 使用选择器快速提取数据
  if (request.action === 'extractBySelector') {
    const selector = request.selector;
    const requirement = request.requirement || '';
    const lazyAttr = request.lazyAttr || 'src';
    const filterPatterns = request.filterPatterns || [];
    
    try {
      const elements = document.querySelectorAll(selector);
      const data = [];
      
      // 根据需求判断要提取什么
      const isImage = requirement.includes('图片') || requirement.includes('img') || requirement.includes('photo');
      const isLink = requirement.includes('链接') || requirement.includes('href');
      
      for (const el of elements) {
        let value = '';
        
        if (isImage) {
          let imgEl = el;
          if (el.tagName === 'A' || el.tagName === 'DIV') {
            imgEl = el.querySelector('img') || el;
          }
          
          if (imgEl.tagName === 'IMG') {
            // 优先使用指定的懒加载属性
            let src = imgEl.getAttribute(lazyAttr);
            
            // 如果指定属性没有值，尝试其他常见属性
            if (!src || src.startsWith('data:') || src.includes('loading')) {
              const fallbackAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-default', 'srcset', 'src'];
              for (const attr of fallbackAttrs) {
                const val = imgEl.getAttribute(attr);
                if (val && !val.startsWith('data:') && !val.includes('loading') && val.length > 10) {
                  src = val;
                  break;
                }
              }
            }
            
            // 检查是否需要从 srcset 解析
            if (src === imgEl.srcset) {
              src = src.split(' ')[0];
            }
            
            value = src || '';
            
            // 处理相对路径
            if (value) {
              if (value.startsWith('//')) {
                value = window.location.protocol + value;
              } else if (value.startsWith('/')) {
                value = window.location.origin + value;
              }
            }
          }
        } else if (isLink && el.tagName === 'A') {
          value = el.href || '';
        }
        
        // 如果没有提取到特殊属性，提取文本
        if (!value) {
          value = el.textContent.trim();
        }
        
        // 过滤无效数据和需要排除的图片
        if (value && value.length > 0 && value !== '[object Object]') {
          const shouldFilter = filterPatterns.some(pattern => value.includes(pattern));
          if (!shouldFilter) {
            data.push(value);
          }
        }
      }
      sendResponse({ data: data });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }
  
  return true;
});

// ==================== 精确选择器生成 ====================

function findElementByText(text, maxLength = 50) {
  if (!text || text.length < 2) return null;
  
  const truncatedText = text.substring(0, maxLength);
  const allElements = document.querySelectorAll('*');
  
  for (const el of allElements) {
    const elText = el.textContent.trim().replace(/\s+/g, ' ');
    if (elText.includes(truncatedText) || truncatedText.includes(elText.substring(0, 30))) {
      const path = getElementPath(el);
      const uniqueAttrs = getUniqueAttrs(el);
      const tag = el.tagName.toLowerCase();
      
      return {
        path: path,
        tag: tag,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : '',
        attributes: uniqueAttrs,
        text: elText.substring(0, 100),
        rect: el.getBoundingClientRect()
      };
    }
  }
  return null;
}

function getElementPath(element) {
  if (!element || element === document.body || element === document.documentElement) {
    return 'body';
  }
  
  if (element.id) {
    return `#${element.id}`;
  }
  
  const path = [];
  let current = element;
  
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    
    if (current.id) {
      path.unshift(`#${current.id}`);
      break;
    }
    
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => c && c.length < 30);
      if (classes.length > 0) {
        const shortClasses = classes.slice(0, 2);
        selector += '.' + shortClasses.join('.');
      }
    }
    
    const parent = current.parentElement;
    if (parent && parent.children.length > 1) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    
    path.unshift(selector);
    current = current.parentElement;
  }
  
  return path.join(' > ') || 'body';
}

function getUniqueAttrs(element) {
  const attrs = {};
  const important = ['class', 'id', 'data-id', 'data-v-', 'role', 'itemtype', 'itemprop', 'aria-label', 'data-testid'];
  
  for (const attr of element.attributes) {
    const name = attr.name;
    if (important.some(k => name === k || name.startsWith(k))) {
      attrs[name] = attr.value;
    }
  }
  
  return attrs;
}

function findMultipleElementsByTexts(texts) {
  const results = [];
  
  for (const text of texts) {
    if (!text || text.length < 2) continue;
    
    const truncatedText = text.substring(0, 40);
    const allElements = document.querySelectorAll('*');
    
    let found = false;
    for (const el of allElements) {
      if (found) break;
      
      const elText = el.textContent.trim().replace(/\s+/g, ' ');
      if (elText.includes(truncatedText) || (truncatedText.length > 10 && elText.substring(0, 20) === truncatedText.substring(0, 20))) {
        results.push({
          text: text.substring(0, 50),
          path: getElementPath(el),
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join(' ') : '',
          attributes: getUniqueAttrs(el),
          matchedText: elText.substring(0, 50)
        });
        found = true;
      }
    }
  }
  
  return results;
}

function findElementsBySelector(selector) {
  try {
    const elements = document.querySelectorAll(selector);
    return Array.from(elements).map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join(' ') : '',
      text: el.textContent.trim().substring(0, 100),
      attributes: getUniqueAttrs(el),
      rect: el.getBoundingClientRect()
    }));
  } catch (e) {
    return [];
  }
}

function validateSelectorOnPage(selector) {
  try {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) {
      return { valid: false, count: 0 };
    }
    
    const samples = Array.from(elements).slice(0, 3).map(el => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent.trim().substring(0, 50),
      hasText: el.textContent.trim().length > 0
    }));
    
    return {
      valid: true,
      count: elements.length,
      samples: samples
    };
  } catch (e) {
    return { valid: false, count: 0, error: e.message };
  }
}

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
    word-break: break-all;
    white-space: pre-wrap;
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
  // 注意：按钮状态由 progress 消息统一控制，不要在这里修改
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

let isExtracting = false;

function setExtractingState(extracting) {
  isExtracting = extracting;
  const sendBtn = document.getElementById('crawlmind-send');
  if (sendBtn) {
    if (extracting) {
      sendBtn.textContent = '停止中...';
      sendBtn.style.background = '#f44336';
      sendBtn.style.cursor = 'pointer';
      sendBtn.onclick = stopExtract;
    } else {
      sendBtn.textContent = '发送';
      sendBtn.style.background = '#667eea';
      sendBtn.onclick = sendMessage;
    }
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
  
  // 重置停止标志
  chrome.storage.local.set({ stopExtract: false });
  
  // 切换按钮状态为停止
  setExtractingState(true);
  
  // 判断是否需要分析页面
  const keywords = ['爬取', '抓取', '采集', '获取', '提取', '数据', '商品', '评论', '价格', '标题', '内容', '链接', '图片'];
  const needAnalysis = keywords.some(kw => message.includes(kw));
  
  const handleResponse = (response) => {
    setExtractingState(false);
    if (chrome.runtime.lastError) {
      addMessage('system', '错误: ' + chrome.runtime.lastError.message);
      return;
    }
    addMessage('system', response.result || '分析完成');
  };
  
  if (needAnalysis) {
    addMessage('system', '正在分析页面结构...');
    
    chrome.runtime.sendMessage({ 
      action: 'chat', 
      message: message,
      treeText: treeText 
    }, handleResponse);
  } else {
    addMessage('system', '正在思考...');
    
    chrome.runtime.sendMessage({ 
      action: 'chat',
      message: message,
      mode: 'casual',
      treeText: treeText 
    }, handleResponse);
  }
}

// 初始化浮窗
createFloatingButton();
