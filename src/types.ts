export type Status = 'queued' | 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export const ACTIVE = new Set<Status>(['queued', 'starting', 'running', 'waiting_input']);
export interface ModelChoice { provider: string; id: string; thinking?: string }
export interface Message {
  id: string; runId: string; role: string; text: string; complete: boolean;
  timestamp: number; toolName?: string; error?: string;
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
  activity: string; error?: string; messages: Message[]; tokens: number;
  toolUses: number; dialogs: Dialog[]; queued: Array<{message: string; mode: 'steer' | 'followUp'}>;
  pendingMessages: number; notified?: boolean;
  undelivered?: string[];
}
export interface Completion {
  id: string; agentId: string; runId: string; threadId: string; name: string;
  status: Status; text: string; partial: boolean; createdAt: number;
  acknowledged: boolean; offeredTurn?: string;
}
export interface Parent { threadId: string; cwd: string; permissionMode?: string; turnId?: string; updatedAt: number }
export interface Database {
  version: 1; agents: Agent[]; completions: Completion[]; parents: Parent[];
}
export interface Snapshot { agents: Agent[]; pendingCompletions: number }
export interface SpawnInput { name: string; task: string; context?: string; cwd?: string; model?: ModelChoice }
export interface Request { id: string; method: string; threadId?: string; args?: Record<string, any> }
export interface Response { id: string; result?: any; error?: string }
export type PiRecord = Record<string, any>;
