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
    showUserConfirmDialog(request.data, request.requirement, sendResponse, request.isSelectorTest);
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
  
  // 窗口滚动（当没有滚动容器时使用）
  if (request.action === 'windowScroll') {
    const startY = window.scrollY;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    
    if (startY >= maxY) {
      sendResponse({ success: false, reason: 'already_at_bottom' });
      return true;
    }
    
    // 滚动到页面底部
    window.scrollTo({
      top: maxY,
      behavior: 'smooth'
    });
    
    // 等待滚动完成
    setTimeout(() => {
      const newY = window.scrollY;
      sendResponse({ 
        success: newY > startY, 
        fromY: startY, 
        toY: newY,
        reason: newY > startY ? 'scrolled' : 'already_at_bottom'
      });
    }, 2000);
    
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
  
  // 使用 Shadow DOM 路径提取数据
  if (request.action === 'extractByShadowPath') {
    const { simplePath, shadowParts, requirement, lazyAttr, filterPatterns } = request;
    const data = extractByShadowPath(simplePath, shadowParts, requirement, lazyAttr, filterPatterns);
    sendResponse({ data: data });
    return true;
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
      const results = querySelectorAllDeep(selector);
      const data = [];
      
      // 根据需求判断要提取什么
      const isImage = requirement.includes('图片') || requirement.includes('img') || requirement.includes('photo');
      const isLink = requirement.includes('链接') || requirement.includes('href');
      
      for (const { element } of results) {
        let value = '';
        
        if (isImage) {
          let imgEl = element;
          if (element.tagName === 'A' || element.tagName === 'DIV') {
            imgEl = element.querySelector('img') || element;
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
        } else if (isLink && element.tagName === 'A') {
          value = element.href || '';
        }
        
        // 如果没有提取到特殊属性，提取文本
        if (!value) {
          value = element.textContent.trim();
        }
        
        // 过滤无效数据和需要排除的图片
        if (value && value.length > 0 && value !== '[object Object]') {
          const shouldFilter = filterPatterns.some(pattern => value.includes(pattern));
          if (!shouldFilter) {
            data.push(value);
          }
        }
      }
      sendResponse({ data: data, count: results.length });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }
  
  return true;
});

// ==================== 精确选择器生成 ====================

function findAllElementsDeep(root = document) {
  const elements = [];
  const stack = [{ node: root, shadowPath: [] }];
  
  while (stack.length > 0) {
    const { node, shadowPath } = stack.pop();
    
    if (node.nodeType === Node.ELEMENT_NODE) {
      elements.push({ element: node, shadowPath: shadowPath });
    }
    
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) {
        stack.push({ node: child, shadowPath: [...shadowPath, node] });
      }
    }
    
    if (node.children) {
      for (const child of node.children) {
        stack.push({ node: child, shadowPath: shadowPath });
      }
    }
  }
  
  return elements;
}

function querySelectorFromFullPath(fullPath) {
  const results = [];
  
  try {
    // 解析路径: document.querySelector("bili-comments").shadowRoot.querySelector("#feed > bili-comment-thread-renderer:nth-child(9)")
    const selectors = [];
    
    // 提取第一个选择器
    const mainMatch = fullPath.match(/document\.querySelector\("([^"]+)"\)/);
    if (mainMatch) {
      selectors.push(mainMatch[1]);
    }
    
    // 提取所有 shadowRoot.querySelector 中的选择器
    const shadowMatches = fullPath.matchAll(/\.shadowRoot\.querySelector\("([^"]+)"\)/g);
    for (const match of shadowMatches) {
      selectors.push(match[1]);
    }
    
    if (selectors.length === 0) return results;
    
    // 递归查找函数
    function findInShadow(element, selectorIndex, currentShadowPath) {
      if (selectorIndex >= selectors.length) {
        results.push({ element: element, shadowPath: [...currentShadowPath] });
        return;
      }
      
      const selector = selectors[selectorIndex];
      const parts = selector.split('>').map(s => s.trim());
      
      if (parts.length === 1 && !selector.includes(':nth-of-type')) {
        // 简单选择器，直接使用 querySelector
        if (element.shadowRoot) {
          const found = element.shadowRoot.querySelector(selector);
          if (found) {
            currentShadowPath.push(element);
            findInShadow(found, selectorIndex + 1, currentShadowPath);
          }
        }
      } else {
        // 复合选择器，需要逐层查找
        if (element.shadowRoot) {
          const allElements = element.shadowRoot.querySelectorAll('*');
          const matched = [];
          
          for (const el of allElements) {
            if (matchesSelector(el, selector)) {
              matched.push(el);
            }
          }
          
          // 如果选择器包含 :nth-of-type，匹配特定元素
          const nthMatch = selector.match(/:nth-of-type\((\d+)\)/);
          let targetEl = null;
          
          if (nthMatch) {
            const nth = parseInt(nthMatch[1]) - 1;
            if (nth >= 0 && nth < matched.length) {
              targetEl = matched[nth];
            }
          } else {
            targetEl = matched[0];
          }
          
          if (targetEl) {
            currentShadowPath.push(element);
            findInShadow(targetEl, selectorIndex + 1, currentShadowPath);
          }
        }
      }
    }
    
    // 从第一个选择器开始
    const firstSelector = selectors[0];
    const firstParts = firstSelector.split('>').map(s => s.trim());
    
    if (firstParts.length === 1 && !firstSelector.includes(':nth-of-type')) {
      const firstElements = document.querySelectorAll(firstSelector);
      for (const el of firstElements) {
        findInShadow(el, 1, []);
      }
    } else {
      // 第一个选择器也是复合的
      const allElements = document.querySelectorAll('*');
      const matched = [];
      
      for (const el of allElements) {
        if (matchesSelector(el, firstSelector)) {
          matched.push(el);
        }
      }
      
      const nthMatch = firstSelector.match(/:nth-of-type\((\d+)\)/);
      let targetEl = null;
      
      if (nthMatch) {
        const nth = parseInt(nthMatch[1]) - 1;
        if (nth >= 0 && nth < matched.length) {
          targetEl = matched[nth];
        }
      } else {
        targetEl = matched[0];
      }
      
      if (targetEl) {
        findInShadow(targetEl, 1, []);
      }
    }
  } catch (e) {
    console.error('Error parsing full path:', e);
  }
  
  return results;
}

function matchesSelector(element, selector) {
  try {
    // 解析复合选择器（如 "#feed > bili-comment-thread-renderer:nth-child(9)"）
    const parts = selector.split('>').map(s => s.trim());
    
    // 检查是否匹配所有部分
    let current = element;
    
    // 从后往前匹配
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i].replace(/:nth-of-type\(\d+\)/, '').trim();
      
      const tagMatch = part.match(/^([a-z][\w-]*)/i);
      const idMatch = part.match(/#([\w-]+)/);
      const classMatches = part.match(/\.([\w-]+)/g) || [];
      
      // 检查标签
      if (tagMatch) {
        if (current.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      }
      
      // 检查 ID
      if (idMatch) {
        if (current.id !== idMatch[1]) return false;
      }
      
      // 检查 class
      for (const classMatch of classMatches) {
        const cls = classMatch.substring(1);
        if (!current.className || !current.className.includes(cls)) return false;
      }
      
      // 移动到父元素
      if (i > 0 && current.parentElement) {
        current = current.parentElement;
      }
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

function querySelectorByShadowPath(shadowPath) {
  // 处理 >> 格式的 Shadow DOM 路径
  // 例如: bili-comments >> #feed > bili-comment-thread-renderer >> #comment
  const results = [];
  const parts = shadowPath.split(' >> ').map(p => p.trim());
  
  if (parts.length === 0) return results;
  
  try {
    // 解析第一个选择器（light DOM）
    const firstSelector = parts[0];
    let candidates = Array.from(document.querySelectorAll(firstSelector));
    
    console.log('CrawlMind querySelectorByShadowPath step 0:', firstSelector, 'found', candidates.length);
    
    if (candidates.length === 0) {
      console.log('CrawlMind: No elements found for:', firstSelector);
      return results;
    }
    
    // 逐层遍历 Shadow DOM
    for (let i = 1; i < parts.length; i++) {
      const shadowPart = parts[i];
      const nextCandidates = [];
      
      console.log('CrawlMind step', i, ':', shadowPart, 'candidates:', candidates.length);
      
      for (const candidate of candidates) {
        if (!candidate.shadowRoot) {
          console.log('CrawlMind: no shadowRoot on', candidate.tagName);
          continue;
        }
        
        // 解析选择器（可能包含多个用 > 分隔的部分）
        const selectors = shadowPart.split('>').map(s => s.trim());
        let currentElements = [candidate.shadowRoot];
        
        for (const sel of selectors) {
          if (!sel) continue;
          
          const nextElements = [];
          for (const curr of currentElements) {
            try {
              const matched = curr.querySelectorAll(sel);
              console.log('CrawlMind: querySelector', sel, 'found', matched.length);
              nextElements.push(...matched);
            } catch (e) {
              console.log('CrawlMind: querySelector error:', e.message);
            }
          }
          currentElements = nextElements;
        }
        
        nextCandidates.push(...currentElements);
      }
      
      console.log('CrawlMind step', i, 'result:', nextCandidates.length);
      candidates = nextCandidates;
      
      if (candidates.length === 0) break;
    }
    
    // 收集最终结果
    for (const el of candidates) {
      results.push({ element: el, shadowPath: [] });
    }
    
    console.log('CrawlMind querySelectorByShadowPath final:', results.length, 'results');
  } catch (e) {
    console.error('Error in querySelectorByShadowPath:', e);
  }
  
  return results;
}

function extractByShadowPath(simplePath, shadowParts, requirement, lazyAttr = 'src', filterPatterns = []) {
  const data = [];
  
  try {
    // 第一步：构建完整路径
    const fullPath = simplePath + (shadowParts.length > 0 ? ' >> ' + shadowParts.join(' >> ') : '');
    
    console.log('CrawlMind extractByShadowPath:', { simplePath, shadowParts, fullPath });
    
    // 使用 querySelectorByShadowPath 获取元素
    const results = querySelectorByShadowPath(fullPath);
    
    console.log('CrawlMind querySelectorByShadowPath results:', results.length, 'elements found');
    
    const isImage = requirement.includes('图片') || requirement.includes('img') || requirement.includes('photo');
    const isLink = requirement.includes('链接') || requirement.includes('href');
    
    // 收集所有层级的文本内容
    for (const { element } of results) {
      // 递归获取所有文本
      const texts = [];
      collectAllText(element, texts);
      
      console.log('CrawlMind collected', texts.length, 'texts from element');
      
      for (const text of texts) {
        if (text && text.length > 0 && text !== '[object Object]') {
          const shouldFilter = filterPatterns.some(pattern => text.includes(pattern));
          if (!shouldFilter) {
            data.push(text);
          }
        }
      }
    }
    
    // 如果直接查找失败，尝试更激进的方法
    if (data.length === 0 && simplePath) {
      console.log('CrawlMind trying fallback method...');
      const rootElements = document.querySelectorAll(simplePath);
      console.log('CrawlMind found', rootElements.length, 'root elements');
      
      for (const rootEl of rootElements) {
        // 递归收集所有文本
        const texts = [];
        collectAllTextDeep(rootEl, texts);
        
        console.log('CrawlMind fallback collected', texts.length, 'texts');
        
        for (const text of texts) {
          if (text && text.length > 0 && text !== '[object Object]' && text.length > 2) {
            const shouldFilter = filterPatterns.some(pattern => text.includes(pattern));
            if (!shouldFilter) {
              data.push(text);
            }
          }
        }
      }
    }
    
    console.log('CrawlMind extractByShadowPath returning', data.length, 'items');
  } catch (e) {
    console.error('Error extracting from Shadow DOM:', e);
  }
  
  return data;
}

function collectAllText(element, results) {
  // 合并相邻的纯文本节点，跳过子元素
  if (element.shadowRoot) {
    let combinedText = '';
    
    for (const node of element.shadowRoot.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        // 纯文本，累加
        combinedText += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 元素节点，先把累积的文本加入结果
        const trimmed = combinedText.trim();
        if (trimmed && trimmed.length > 2) {
          results.push(trimmed);
        }
        combinedText = '';
      }
    }
    
    // 处理末尾的文本
    const trimmed = combinedText.trim();
    if (trimmed && trimmed.length > 2) {
      results.push(trimmed);
    }
  } else {
    // 没有 shadowRoot，直接获取文本
    const text = element.textContent?.trim();
    if (text && text.length > 2) {
      results.push(text);
    }
  }
}

function collectAllTextDeep(element, results) {
  // 合并相邻的纯文本节点
  let combinedText = '';
  
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      combinedText += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const trimmed = combinedText.trim();
      if (trimmed && trimmed.length > 2) {
        results.push(trimmed);
      }
      combinedText = '';
    }
  }
  
  const trimmed = combinedText.trim();
  if (trimmed && trimmed.length > 2) {
    results.push(trimmed);
  }
  
  // 进入元素的 Shadow DOM
  if (element.shadowRoot) {
    for (const child of element.shadowRoot.children) {
      collectAllTextDeep(child, results);
    }
  }
  
  // 同时遍历普通子元素
  for (const child of element.children) {
    collectAllTextDeep(child, results);
  }
}

function collectAllElements(element, results) {
  results.push(element);
  
  // 进入元素的 Shadow DOM
  if (element.shadowRoot) {
    for (const child of element.shadowRoot.children) {
      collectAllElements(child, results);
    }
  }
  
  // 同时遍历普通子元素
  for (const child of element.children) {
    collectAllElements(child, results);
  }
}

function querySelectorAllDeep(selector, root = document) {
  // 处理 >> 格式的 Shadow DOM 路径
  // 例如: bili-comments >> #feed > bili-comment-thread-renderer
  if (selector.includes(' >> ')) {
    return querySelectorByShadowPath(selector);
  }
  
  const results = [];
  const stack = [{ node: root, shadowPath: [] }];
  
  while (stack.length > 0) {
    const { node, shadowPath } = stack.pop();
    
    try {
      if (node.matches && node.matches(selector)) {
        results.push({ element: node, shadowPath: shadowPath });
      }
    } catch (e) {}
    
    if (node.shadowRoot) {
      try {
        const shadowResults = node.shadowRoot.querySelectorAll(selector);
        for (const el of shadowResults) {
          results.push({ element: el, shadowPath: [...shadowPath, node] });
        }
      } catch (e) {}
      
      for (const child of node.shadowRoot.children) {
        stack.push({ node: child, shadowPath: [...shadowPath, node] });
      }
    }
    
    if (node.children) {
      for (const child of node.children) {
        stack.push({ node: child, shadowPath: shadowPath });
      }
    }
  }
  
  return results;
}

function getElementPath(element, shadowPath = []) {
  if (!element || element === document.body || element === document.documentElement) {
    return 'body';
  }
  
  const pathParts = [];
  
  for (const shadowHost of shadowPath) {
    const hostTag = shadowHost.tagName.toLowerCase();
    const hostId = shadowHost.id ? `#${shadowHost.id}` : '';
    if (hostId) {
      pathParts.push(`${hostTag}${hostId}.shadowRoot`);
    } else {
      const hostClasses = typeof shadowHost.className === 'string' 
        ? shadowHost.className.split(/\s+/).filter(c => c && c.length < 30).slice(0, 2).join('.')
        : '';
      pathParts.push(`${hostTag}${hostClasses ? '.' + hostClasses : ''}.shadowRoot`);
    }
  }
  
  if (element.id) {
    pathParts.push(`#${element.id}`);
    return pathParts.join(' > ');
  }
  
  let current = element;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    
    if (current.id) {
      pathParts.push(`#${current.id}`);
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
    
    pathParts.push(selector);
    current = current.parentElement;
  }
  
  return pathParts.join(' > ') || 'body';
}

function buildFullPath(element, shadowPath = []) {
  // 生成完整的 Shadow DOM 路径
  // 例如: document.querySelector("#commentapp > bili-comments").shadowRoot.querySelector("#feed > bili-comment-thread-renderer")
  
  const parts = [];
  
  // 从 shadowPath 构建部分
  for (const shadowHost of shadowPath) {
    const tag = shadowHost.tagName.toLowerCase();
    const id = shadowHost.id ? `#${shadowHost.id}` : '';
    const classes = typeof shadowHost.className === 'string'
      ? shadowHost.className.split(/\s+/).filter(c => c && c.length < 30).slice(0, 2).map(c => `.${c}`).join('')
      : '';
    
    if (id) {
      parts.push(`${tag}${id}`);
    } else if (classes) {
      parts.push(`${tag}${classes}`);
    } else {
      parts.push(tag);
    }
  }
  
  // 添加目标元素
  const targetTag = element.tagName.toLowerCase();
  const targetId = element.id ? `#${element.id}` : '';
  const targetClasses = typeof element.className === 'string'
    ? element.className.split(/\s+/).filter(c => c && c.length < 30).slice(0, 2).map(c => `.${c}`).join('')
    : '';
  
  if (targetId) {
    parts.push(`${targetTag}${targetId}`);
  } else if (targetClasses) {
    parts.push(`${targetTag}${targetClasses}`);
  } else {
    parts.push(targetTag);
  }
  
  // 构建最终路径
  // 使用 >> 表示进入 Shadow DOM
  if (parts.length === 0) {
    return 'document';
  }
  
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    result += ` >> ${parts[i]}`;
  }
  
  return result;
}

function findElementByText(text, maxLength = 50) {
  if (!text || text.length < 2) return null;
  
  const searchText = text.substring(0, maxLength).trim();
  const allElements = findAllElementsDeep();
  
  // 第一轮：精确匹配（完全相等）
  for (const { element, shadowPath } of allElements) {
    const elText = element.textContent.trim().replace(/\s+/g, ' ');
    if (elText === searchText) {
      const path = getElementPath(element, shadowPath);
      const fullPath = buildFullPath(element, shadowPath);
      const uniqueAttrs = getUniqueAttrs(element);
      const tag = element.tagName.toLowerCase();
      
      return {
        path: path,
        fullPath: fullPath,
        tag: tag,
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className : '',
        attributes: uniqueAttrs,
        text: elText.substring(0, 100),
        rect: element.getBoundingClientRect ? element.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 },
        hasShadowDOM: shadowPath.length > 0,
        matchType: 'exact'
      };
    }
  }
  
  // 第二轮：文本开头匹配（以搜索文本开头）
  for (const { element, shadowPath } of allElements) {
    const elText = element.textContent.trim().replace(/\s+/g, ' ');
    if (elText.startsWith(searchText) && elText.length < searchText.length + 50) {
      const path = getElementPath(element, shadowPath);
      const fullPath = buildFullPath(element, shadowPath);
      const uniqueAttrs = getUniqueAttrs(element);
      const tag = element.tagName.toLowerCase();
      
      return {
        path: path,
        fullPath: fullPath,
        tag: tag,
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className : '',
        attributes: uniqueAttrs,
        text: elText.substring(0, 100),
        rect: element.getBoundingClientRect ? element.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 },
        hasShadowDOM: shadowPath.length > 0,
        matchType: 'prefix'
      };
    }
  }
  
  // 第三轮：包含匹配（作为备选）
  for (const { element, shadowPath } of allElements) {
    const elText = element.textContent.trim().replace(/\s+/g, ' ');
    if (elText.includes(searchText)) {
      const path = getElementPath(element, shadowPath);
      const fullPath = buildFullPath(element, shadowPath);
      const uniqueAttrs = getUniqueAttrs(element);
      const tag = element.tagName.toLowerCase();
      
      return {
        path: path,
        fullPath: fullPath,
        tag: tag,
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className : '',
        attributes: uniqueAttrs,
        text: elText.substring(0, 100),
        rect: element.getBoundingClientRect ? element.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 },
        hasShadowDOM: shadowPath.length > 0,
        matchType: 'contains'
      };
    }
  }
  
  return null;
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
    const allElements = findAllElementsDeep();
    
    let found = false;
    for (const { element, shadowPath } of allElements) {
      if (found) break;
      
      const elText = element.textContent.trim().replace(/\s+/g, ' ');
      if (elText.includes(truncatedText) || (truncatedText.length > 10 && elText.substring(0, 20) === truncatedText.substring(0, 20))) {
        results.push({
          text: text.substring(0, 50),
          path: getElementPath(element, shadowPath),
          fullPath: buildFullPath(element, shadowPath),
          tag: element.tagName.toLowerCase(),
          id: element.id || '',
          className: typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 3).join(' ') : '',
          attributes: getUniqueAttrs(element),
          matchedText: elText.substring(0, 50),
          hasShadowDOM: shadowPath.length > 0
        });
        found = true;
      }
    }
  }
  
  return results;
}

function findElementsBySelector(selector) {
  try {
    const results = querySelectorAllDeep(selector);
    return results.map(({ element, shadowPath }, i) => ({
      index: i,
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 3).join(' ') : '',
      text: element.textContent.trim().substring(0, 100),
      attributes: getUniqueAttrs(element),
      rect: element.getBoundingClientRect ? element.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 },
      hasShadowDOM: shadowPath.length > 0,
      fullPath: buildFullPath(element, shadowPath)
    }));
  } catch (e) {
    return [];
  }
}

function validateSelectorOnPage(selector) {
  try {
    const results = querySelectorAllDeep(selector);
    if (results.length === 0) {
      return { valid: false, count: 0 };
    }
    
    const samples = results.slice(0, 3).map(({ element }) => ({
      tag: element.tagName.toLowerCase(),
      text: element.textContent.trim().substring(0, 50),
      hasText: element.textContent.trim().length > 0
    }));
    
    return {
      valid: true,
      count: results.length,
      samples: samples,
      hasShadowDOM: results.some(r => r.shadowPath.length > 0)
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
function showUserConfirmDialog(data, requirement, sendResponse, isSelectorTest = false) {
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
  
  const title = isSelectorTest ? '🎯 请确认选择器提取的数据是否正确' : '📋 请确认这是您要的数据';
  const requirementLabel = isSelectorTest ? '选择器测试' : '需求';
  
  // 显示提取的数据预览
  const dataPreview = document.createElement('div');
  dataPreview.className = 'confirm-dialog';
  dataPreview.style.cssText = 'padding: 12px; margin: 8px 0; background: #e3f2fd; border-radius: 8px; font-size: 13px; max-height: 200px; overflow-y: auto;';
  dataPreview.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 8px;">${title}</div>
    <div style="color: #666; margin-bottom: 8px;">${requirementLabel}: ${requirement}</div>
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
      addMessage('system', isSelectorTest ? '✅ 用户确认选择器正确' : '✅ 用户确认数据正确');
      dataPreview.remove();
      sendResponse({ confirmed: true });
    });
  };
  
  // 绑定拒绝按钮
  document.getElementById('crawlmind-confirm-no').onclick = () => {
    chrome.storage.local.set({ userConfirmed: false }, () => {
      addMessage('system', isSelectorTest ? '❌ 用户拒绝该选择器，将尝试其他方法' : '❌ 用户拒绝该数据，将重新寻找');
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
