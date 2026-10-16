import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownText } from '../web/markdown.js';

const render = (text: string) => renderToStaticMarkup(React.createElement(MarkdownText, { text }));

test('Markdown messages render headings, lists, quotes, fences and GFM tables/tasks', () => {
  const html = render('# 标题\n\n**加粗**与 `inline`\n\n- 列表\n- [x] 完成\n\n> 引用\n\n```ts\nconst n = 1;\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| Pi | 正常 |\n\n~~旧内容~~\n\n[文档](https://example.com)');
  for (const tag of ['h1', 'strong', 'ul', 'blockquote', 'pre', 'table', 'del']) assert.match(html, new RegExp(`<${tag}(?:\\s|>)`));
  assert.match(html, /type="checkbox"/);
  assert.match(html, /class="language-ts"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('untrusted Markdown cannot inject HTML, executable links or automatic remote images', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[unsafe](javascript:alert%281%29)\n\n![外部图片](https://example.com/tracker.png)');
  assert.doesNotMatch(html, /<script|<img|onerror|href="javascript:/i);
  assert.match(html, /外部图片/);
  assert.match(html, /href="https:\/\/example.com\/tracker.png"/);
});

test('streaming unfinished Markdown renders safely and preserves code as text', () => {
  assert.match(render('## 正在输出\n\n```js\nconsole.log("<img onerror=x>")'), /&lt;img onerror=x&gt;/);
  assert.match(render('**未结束的加粗'), /未结束的加粗/);
});
