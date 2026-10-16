// Activity names and compact token formatting adapted from tintinweb/pi-subagents
// src/ui/agent-widget.ts (MIT, Copyright (c) 2026 tintinweb).
export const compactTokens = (count: number) => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
export function elapsed(start?: number, end?: number) {
  if (!start) return '—';
  const seconds = Math.max(0, Math.floor(((end || Date.now()) - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
export const statusLabel: Record<string, string> = { queued: '排队中', starting: '启动中', running: '运行中', waiting_input: '等待主会话', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' };
export const activityLabel = (activity: string) => ({ thinking: '正在思考', responding: '正在回复', reading: '正在读取文件', searching: '正在搜索', editing: '正在编辑', writing: '正在写入', 'running command': '正在执行命令', compacting: '正在压缩上下文', connecting: '正在连接模型', starting: '正在启动 pi', queued: '等待运行名额', 'waiting for input': '等待主会话处理', 'finding files': '正在查找文件', listing: '正在列出目录' } as Record<string, string>)[activity] || statusLabel[activity] || activity;
