export type Status = 'queued' | 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export const ACTIVE = new Set<Status>(['queued', 'starting', 'running', 'waiting_input']);
export interface ModelChoice { provider: string; id: string; thinking?: string }
export type ProfileName = 'worker' | 'reviewer' | 'explorer';
export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  id: string; runId: string; role: string; text: string; complete: boolean;
  timestamp: number; toolName?: string; toolCallId?: string; toolCalls?: ToolCall[];
  command?: string; isError?: boolean; error?: string;
  /** Panel-only preview/page metadata; the persisted message remains complete. */
  textTotal?: number; textOffset?: number;
}
export interface Dialog {
  id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title?: string;
  message?: string; options?: string[]; placeholder?: string; prefill?: string;
  expiresAt?: number;
}
export interface Agent {
  id: string; threadId: string; name: string; cwd: string; status: Status;
  runId: string; task: string; context?: string; model?: ModelChoice;
  sessionFile?: string; createdAt: number; startedAt?: number; finishedAt?: number;
  /** Total retained messages. Poll snapshots window `messages` to the newest few, so this reports the unwindowed count. */
  messageTotal?: number;
  /** Current run's persisted completion text, included in completed panel snapshots. */
  finalText?: string;
  finalTextTotal?: number; completionId?: string;
  /** Ordered newest-window IDs for the opt-in message-delta panel transport. */
  messageIds?: string[];
  activity: string; error?: string; messages: Message[]; tokens: number;
  toolUses: number; dialogs: Dialog[]; queued: Array<{message: string; mode: 'steer' | 'followUp'}>;
  pendingMessages: number; notified?: boolean;
  undelivered?: string[];
  profile?: ProfileName; path?: string; group?: string; archivedAt?: number;
  inbox?: string[];
  queuePosition?: number; queueReason?: string;
}
export interface Completion {
  id: string; agentId: string; runId: string; threadId: string; name: string;
  status: Status; text: string; partial: boolean; createdAt: number;
  acknowledged: boolean; offeredTurn?: string;
}
export interface Parent { threadId: string; cwd: string; permissionMode?: string; turnId?: string; updatedAt: number }
export interface MailEvent {
  id: string; sequence: number; threadId: string; agentId: string; runId: string;
  name: string; kind: 'message' | 'input' | 'completion'; text: string;
  createdAt: number; requestId?: string; completionId?: string;
  acknowledged: boolean; offeredTurn?: string;
}
export interface Receipt {
  threadId: string; method: string; key: string; fingerprint: string;
  state: 'pending' | 'completed' | 'uncertain'; result?: unknown;
}
export interface Database {
  version: 1; agents: Agent[]; completions: Completion[]; parents: Parent[];
  events: MailEvent[]; receipts: Receipt[];
}
export interface Snapshot { agents: Agent[]; pendingCompletions: number }
export interface SpawnInput { name: string; task: string; context?: string; cwd?: string; model?: ModelChoice; profile?: ProfileName; path?: string; group?: string; requestId?: string }
export interface Request { id: string; method: string; threadId?: string; args?: Record<string, any> }
export interface Response { id: string; result?: any; error?: string }
export type PiRecord = Record<string, any>;
