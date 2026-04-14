/**
 * Rubyn Code VS Code extension — JSON-RPC message types.
 *
 * Every interface here maps to a message exchanged between the VS Code
 * extension (client) and the Rubyn Code CLI process (server) over stdin/stdout.
 */

// ---------------------------------------------------------------------------
// Base JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Request params
// ---------------------------------------------------------------------------

export interface InitializeParams {
  workspacePath: string;
  extensionVersion: string;
  capabilities: {
    inlineDiff: boolean;
    streaming: boolean;
  };
}

export interface PromptParams {
  text: string;
  context: PromptContext;
  sessionId: string;
}

export interface PromptContext {
  activeFile?: string;
  selection?: Selection;
  openFiles?: string[];
  workspacePath: string;
  language?: string;
  cursorLine?: number;
}

export interface Selection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ReviewParams {
  baseBranch: string;
  focus: string;
}

export interface ApproveToolUseParams {
  requestId: string;
  approved: boolean;
}

export interface AcceptEditParams {
  editId: string;
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// Notification params — server → client streaming
// ---------------------------------------------------------------------------

export interface StreamTextParams {
  sessionId: string;
  delta: string;
  done: boolean;
}

export interface StreamCodeBlockParams {
  sessionId: string;
  language: string;
  code: string;
  done: boolean;
}

export interface ToolUseParams {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ToolResultParams {
  requestId: string;
  tool: string;
  success: boolean;
  summary: string;
}

export interface FileEditParams {
  editId: string;
  path: string;
  type: 'modify' | 'create' | 'delete';
  hunks?: Hunk[];
  content?: string;
}

export interface Hunk {
  startLine: number;
  endLine: number;
  originalContent: string;
  newContent: string;
}

export interface FileCreateParams {
  editId: string;
  path: string;
  content: string;
}

export interface ReviewFindingParams {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line: number;
  message: string;
  suggestion?: string;
}

export interface AgentStatusParams {
  state:
    | 'idle'
    | 'thinking'
    | 'tool_use'
    | 'streaming'
    | 'reviewing'
    | 'learning';
  detail?: string;
  toolCalls?: number;
  tokensUsed?: number;
  cost?: number;
}

export interface SubAgentParams {
  type: string;
  status: 'running' | 'completed';
  toolCalls: number;
  summary: string | null;
}

export interface SessionCostParams {
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  totalCost: number;
  sessionBudget: number;
  budgetRemaining: number;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ConfigGetAllResult {
  settings: Record<string, { value: unknown; default: unknown }>;
  providers: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Initialize result
// ---------------------------------------------------------------------------

export interface InitializeResult {
  serverVersion: string;
  capabilities: {
    tools: number;
    skills: number;
    memory: boolean;
    teams: boolean;
    review: boolean;
  };
}

// ---------------------------------------------------------------------------
// Session (kept from the original scaffold)
// ---------------------------------------------------------------------------

export interface RubynSession {
  id: string;
  startedAt: Date;
  budget: number;
  spent: number;
}

// ---------------------------------------------------------------------------
// IDE RPC types — server → client requests (bidirectional)
// ---------------------------------------------------------------------------

export interface IdeOpenDiffParams {
  path: string;
  proposedContent: string;
  title?: string;
}

export interface IdeOpenDiffResult {
  accepted: boolean;
}

export interface IdeReadSelectionResult {
  text: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
}

export interface IdeReadActiveFileResult {
  path: string;
  content: string;
  language: string;
}

export interface IdeSaveFileParams {
  path: string;
}

export interface IdeSaveFileResult {
  saved: boolean;
}

export interface IdeNavigateToParams {
  path: string;
  line?: number;
  column?: number;
}

export interface IdeGetOpenTabsResult {
  tabs: Array<{
    path: string;
    language?: string;
    isDirty: boolean;
  }>;
}

export interface IdeGetDiagnosticsParams {
  file?: string;
}

export interface IdeGetDiagnosticsResult {
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    source?: string;
  }>;
}

export interface IdeGetWorkspaceSymbolsParams {
  query: string;
}

export interface IdeGetWorkspaceSymbolsResult {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line?: number;
    containerName?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Session management types
// ---------------------------------------------------------------------------

export interface SessionListResult {
  sessions: Array<{
    id: string;
    title?: string;
    updatedAt: string;
    messageCount?: number;
  }>;
}

export interface SessionResumeResult {
  resumed: boolean;
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
}

export interface SessionForkResult {
  forked: boolean;
  newSessionId: string;
}

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'accept_edits'
  | 'plan_only'
  | 'auto'
  | 'dont_ask'
  | 'bypass';
