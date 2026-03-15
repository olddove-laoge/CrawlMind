// mcp/server.js - MCP协议服务器
// 作用：让IDE/编辑器可以调用此扩展的能力

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'crawlmind',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

// 工具定义
server.setRequestHandler('listTools', async () => {
  return {
    tools: [
      {
        name: 'analyze_page',
        description: '分析当前网页结构',
        inputSchema: { type: 'object' }
      },
      {
        name: 'generate_spider',
        description: '根据需求生成爬虫代码',
        inputSchema: {
          type: 'object',
          properties: {
            requirements: { type: 'string' }
          }
        }
      }
    ]
  };
});

// 处理工具调用
server.setRequestHandler('callTool', async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === 'analyze_page') {
    // TODO: 调用分析功能
  }
  
  if (name === 'generate_spider') {
    // TODO: 调用爬虫生成
  }
});

// 启动
const transport = new StdioServerTransport();
await server.connect(transport);
