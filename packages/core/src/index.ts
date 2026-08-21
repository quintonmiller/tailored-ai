export type { ActiveSkillRecord, ActiveSkillState } from "./agent/active-skill.js";
export { activateSkill, createActiveSkillState, deactivateSkill } from "./agent/active-skill.js";
export type { ResolvedAgent, ResolvedProfile, SkillCatalogEntry } from "./agent/agents.js";
export { resolveAgent, resolveProfile } from "./agent/agents.js";
export type { CompactOptions, CompactResult } from "./agent/compact.js";
export {
  compactSession,
  formatCompactResult,
  listSessionCompactions,
  undoCompaction,
} from "./agent/compact.js";
export type {
  ConfigDeclaredSlot,
  ContextSlot,
  ContextSlotContext,
  SlotRefresh,
} from "./agent/context-slots.js";
export {
  clearContextSlots,
  listContextSlots,
  registerContextSlot,
  renderContextSlots,
  unregisterContextSlot,
} from "./agent/context-slots.js";
export type { ResolvedHooks } from "./agent/hooks.js";
export { applyTemplates, EMPTY_HOOKS, executeHooks, hasHooks, mergeHooks, normalizeHooks } from "./agent/hooks.js";
export type { AgentLoopOptions, ModelCandidate } from "./agent/loop.js";
export {
  applyCandidateParams,
  describeTruncation,
  isStallStop,
  type LoopStop,
  runAgentLoop,
  stallReasonOf,
  stripOrphanedToolMessages,
} from "./agent/loop.js";
export { BASE_SYSTEM_PROMPT } from "./agent/prompt.js";
export type { RewindPreview } from "./agent/rewind.js";
export { countTurns, previewRewind, rewindSession, undoRewind } from "./agent/rewind.js";
export type { Session } from "./agent/session.js";
export { findOrCreateSession, loadSession, newSession, resetSession } from "./agent/session.js";
export type { TaskInfo } from "./agent/tasks.js";
export { getTask, listTasks, startTask } from "./agent/tasks.js";
export type { CapToolOutputOptions } from "./agent/tool-output.js";
export { capToolOutput, DEFAULT_MAX_TOOL_OUTPUT_CHARS, resolveToolOutputLimit } from "./agent/tool-output.js";
export type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  PermissionRule,
  PermissionsConfig,
  ToolPermissionConfig,
} from "./approval.js";
export { createApprovalRequestId, evaluatePermission, formatApprovalDescription } from "./approval.js";
export { DiscordChannel } from "./channels/discord.js";
export { type DiscordConfig, type DiscordProjectMapping, getDiscordConfig } from "./channels/discord-config.js";
export type { Channel, IncomingMessage } from "./channels/interface.js";
export { ChannelLifecycleManager } from "./channels/lifecycle.js";
export type { OutboundNotifier } from "./channels/outbound.js";
export {
  type ChannelConnection,
  type ChannelFactory,
  channelFactoryRegistry,
  registerChannelFactory,
  type StartedChannel,
  startRegisteredChannels,
} from "./channels/registry.js";
export { connectMcpServer, type McpConnection, mcpToolName } from "./mcp/client.js";
export { type McpHost, McpManager } from "./mcp/manager.js";
export type { ExpandOptions } from "./prompts/expand.js";
export { applyVars, expandPrompt } from "./prompts/expand.js";
export {
  createRepoBackend,
  type RepoBackendDeps,
  type RepoBackendFactory,
  registerRepoBackendFactory,
  repoBackendFactoryRegistry,
} from "./repo/factory.js";
export { type CmdRunner, GhRepoBackend, type GhRepoBackendOptions, mapPrJson } from "./repo/github.js";
export type {
  MergeProposalInput,
  OpenProposalInput,
  Proposal,
  ProposalRef,
  ProposalState,
  PushBranchInput,
  PushResult,
  RepoBackend,
} from "./repo/interface.js";
export {
  authoredAgentDir,
  authoredAgentManifestPath,
  authoredAgentRoot,
  migrateConfigAgentsToResources,
  populateAgentsFromDisk,
} from "./resources/agent-migration.js";
export {
  type ContainerHandle,
  type ContainerRunner,
  type ContainerRunResult,
  ContainerSandbox,
  type ContainerSandboxOptions,
} from "./sandboxes/container.js";
export {
  type DockerRunner,
  type DockerRunResult,
  DockerSandbox,
  type DockerSandboxOptions,
} from "./sandboxes/docker.js";
export {
  createSandbox,
  registerSandboxFactory,
  type SandboxFactory,
  sandboxFactoryRegistry,
} from "./sandboxes/factory.js";
export { HostSandbox } from "./sandboxes/host.js";
export type {
  Mount,
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxKind,
  SandboxPrepareOptions,
} from "./sandboxes/interface.js";
export { PodmanSandbox, type PodmanSandboxOptions } from "./sandboxes/podman.js";
export { type ActiveSandbox, globalSandboxRegistry, SandboxRegistry } from "./sandboxes/registry.js";
export { type BeadsBackendOptions, type BeadsRunner, BeadsTaskBackend } from "./tasks/beads.js";
export { type BeansBackendOptions, type BeansRunner, BeansTaskBackend } from "./tasks/beans.js";
export {
  createTaskBackend,
  registerTaskBackendFactory,
  type TaskBackendFactory,
  taskBackendFactoryRegistry,
} from "./tasks/factory.js";
export { type GitHubBackendOptions, GitHubTaskBackend } from "./tasks/github.js";
export type {
  Task,
  TaskBackend,
  TaskCreateInput,
  TaskFilter,
  TaskStatusMap,
  TaskUpdateInput,
} from "./tasks/interface.js";
export { NativeTaskBackend } from "./tasks/native.js";
export { LoadSkillTool, type LoadSkillToolOptions } from "./tools/load-skill.js";
export type { UiProvider } from "./ui/interface.js";
export {
  registerUiProviderFactory,
  resolveUiProvider,
  type UiProviderFactory,
  uiProviderFactoryRegistry,
} from "./ui/registry.js";
export type { BranchStrategy, CreateWorktreeOptions, Worktree } from "./worktree.js";
export { autoStash, createWorktree } from "./worktree.js";
// Importing this module registers Discord as the "discord" channel factory.
// Keep the side-effect import last so the registry has the rest of core
// loaded before Discord registers itself.
import "./channels/discord-builtin.js";
// Importing this module registers SqliteMemoryBackend as the "builtin"
// memory backend factory. Same pattern as discord-builtin.
import "./memory/builtin.js";

export {
  type ChunkOptions,
  chunkText,
  type IndexResult,
  indexKbDir,
  indexNote,
} from "./agent/memory-index.js";
export {
  type PromoteOptions,
  type PromoteResult,
  promoteNote,
  recordNoteHit,
  runMemorySweep,
  type SweepOptions,
  type SweepReport,
} from "./agent/memory-promotion.js";
export {
  computeImportance,
  getSessionSummary,
  SESSION_SUMMARY_TAG,
  type SummarizeSessionOptions,
  type SummarizeSessionResult,
  type SweepIdleSessionsOptions,
  type SweepResult,
  summarizeSession,
  sweepIdleSessions,
} from "./agent/summarize-session.js";
export {
  type BuiltInLayers,
  type CustomLayer,
  composeSystemPrompt,
  composeTailBlock,
  DEFAULT_LAYER_ORDER,
  DEFAULT_TAIL_LAYERS,
  type DefaultLayerName,
  mergeSystemPromptOverrides,
  resolveBase,
  resolveCustomLayers,
  resolveTailLayers,
  type SystemPromptOverride,
} from "./agent/system-prompt.js";
export type { DigestResult, DigestSection } from "./autopilot/digest.js";
export { buildMorningDigest, recordDigestRun } from "./autopilot/digest.js";
export type { AutopilotWorkerOptions } from "./autopilot/worker.js";
export { AutopilotWorker, buildTaskPrompt, DEFAULT_AUTOPILOT_TASK_PROMPT } from "./autopilot/worker.js";
export type { Briefing, BriefingRuntime, GenerateBriefingOptions } from "./briefing.js";
export { assembleBriefingContext, DEFAULT_BRIEFING_PROMPT, generateBriefing } from "./briefing.js";
export {
  type ActionClass,
  type AlwaysHitlConfig,
  type CartItem,
  DEFAULT_ALWAYS_HITL,
  evaluateAlwaysHitl,
  formatMediatorState,
  type HitlOverride,
  isAlwaysHitl,
  isAlwaysHitlDefault,
  type MediatorState,
  resolveAlwaysHitl,
} from "./browser/always-hitl.js";
export {
  AlwaysHitlRefusedError,
  type BrowserAuditEntry,
  BrowserMediator,
  type BrowserMediatorOptions,
  classifyButtonText,
  EgressBlockedError,
} from "./browser/mediator.js";
export { asNotifier } from "./channels/discord-builtin.js";
export { DiscordRoomBackend, type DiscordRoomBackendOptions } from "./channels/discord-rooms.js";
export type {
  SlashCommandDescriptor,
  SlashCommandInvocation,
  SlashCommandOption,
  SlashCommandOptionType,
  SlashCommandRegistryView,
  SlashCommandReply,
} from "./commands/registry.js";
export {
  RESERVED_COMMAND_NAMES,
  SlashCommandConflictError,
  SlashCommandRegistry,
  slashCommandRegistry,
} from "./commands/registry.js";
export type { CommandContext, CommandResult, ParsedCommand } from "./commands.js";
export { executeCommand, isCommand, parseCommand } from "./commands.js";
export type {
  AgentConfig,
  AgentDefinition,
  AgentHook,
  AgentProfile,
  CommandConfig,
  CronHook,
  CronJobConfig,
  CustomToolConfig,
  OnlineAgentConfig,
  PluginEntry,
  TaskWatcherConfig,
} from "./config.js";
export {
  DEFAULT_DISABLED_PLUGIN_MODULES,
  DEFAULT_PLUGIN_MODULES,
  findInertConfig,
  findUnknownKeys,
  KNOWN_TOP_LEVEL_CONFIG_KEYS,
  loadConfig,
  mergeProjectOverlay,
  migrateDefaultPlugins,
  normalizeRawConfig,
  validateConfig,
} from "./config.js";
export { AGENT_DEFINITION_KEYS, AgentDefinitionSchema, CronJobConfigSchema, findShapeIssues } from "./config-schema.js";
export type { ConfigWriteHost, ConfigWriteResult } from "./config-write.js";
export { ConfigWriteRejected, updateRawConfig, writeRawConfigText } from "./config-write.js";
export { decodeMessageContent, encodeMessageContent } from "./content/codec.js";
// Media (docs/media-design.md): content parts, the text projection, the
// content-addressed store seam and its bundled disk implementation.
export type { ContentPart, MediaKind, MediaRef, MessageContent, ToolOutput } from "./content/types.js";
export {
  contentParts,
  hasMedia,
  mediaKind,
  mediaPart,
  mediaPlaceholder,
  mediaRefs,
  messageText,
  partsToText,
  textPart,
  toolOutputParts,
  toolOutputText,
} from "./content/types.js";
export { ensureContextDir, loadAllContext, loadContextFiles, migrateContextDir } from "./context.js";
export type { CompiledSchedule } from "./cron/schedule-dsl.js";
export { compileSchedule, parseTime, scheduleToCron } from "./cron/schedule-dsl.js";
export { CronScheduler } from "./cron/scheduler.js";
export { builtinDashboardWidgets } from "./dashboard/builtin.js";
// Dashboard widget seam. Importing builtin.js self-registers the default
// generic widgets (system status, needs-you, recent activity).
export {
  BUILTIN_WIDGET_TYPES,
  type DashboardWidget,
  type DashboardWidgetProvider,
  dashboardWidgetRegistry,
  registerDashboardWidgetProvider,
  resolveDashboardWidgets,
  validateDashboardWidget,
} from "./dashboard/index.js";
export type { AuditEntry, AuditVerifyResult, AuditWriteInput } from "./db/audit-log.js";
export { AuditLog } from "./db/audit-log.js";
export type { AutopilotSettings, BudgetStatus, TokenUsageInput, TokenUsageSource } from "./db/autopilot-queries.js";
export {
  BUDGETED_TOKEN_SOURCES,
  checkBudget,
  getAutopilotSettings,
  getTokenUsageInWindow,
  isInDisabledHours,
  isInQuietHours,
  isInTimeWindow,
  recordTokenUsage,
  updateAutopilotSettings,
} from "./db/autopilot-queries.js";
export {
  type ChunkSearchHit,
  countChunks,
  createChunk,
  deleteChunksBySource,
  getChunk,
  listChunksBySource,
  type MemoryChunk,
  type MemoryChunkInput,
  semanticSearch,
} from "./db/chunk-queries.js";
export type {
  Collection,
  CollectionInput,
  CollectionListFilter,
  CollectionListResult,
  CollectionStats,
  CollectionType,
} from "./db/collection-queries.js";
export {
  createCollection,
  deleteCollection,
  getCollection,
  getCollectionStats,
  listCollections,
  normalizeCollectionType,
} from "./db/collection-queries.js";
export type { DocumentMeta } from "./db/document-queries.js";
export { createDocument, deleteDocument, getDocument, listDocuments, updateDocument } from "./db/document-queries.js";
// Email-seen helpers — re-exported so external plugin packages (e.g.
// @tailored-ai/google-tools) can dedupe inbound emails using the core's
// schema rather than re-implementing it.
export {
  type EmailDisposition,
  type EmailSeenQuery,
  type EmailSeenRow,
  filterUnseenIds,
  getEmailSeen,
  isEmailSeen,
  listEmailSeen,
  type MarkEmailSeenInput,
  markEmailSeen,
  updateEmailDisposition,
} from "./db/email-seen-queries.js";
export type {
  CompleteExploratoryRunInput,
  CreateExploratoryRunInput,
  ExploratoryRun,
  ExploratoryRunStatus,
  ExploratoryState,
  ExploratoryStateUpdate,
  ListExploratoryRunsOptions,
} from "./db/exploratory-queries.js";
export {
  completeExploratoryRun,
  createExploratoryRun,
  ensureExploratoryState,
  getExploratoryRun,
  getExploratoryState,
  listExploratoryRuns,
  listExploratoryStates,
  maybeResetDailyCounters,
  updateExploratoryState,
} from "./db/exploratory-queries.js";
export type { Fact, FactInput, FactQuery } from "./db/fact-queries.js";
export {
  deleteFact,
  findFact,
  forgetFact,
  getFact,
  listFacts,
  upsertFact,
} from "./db/fact-queries.js";
export {
  type CreateFormPendingInput,
  cancelOrphanedForms,
  createFormPending,
  type FormPendingStatus,
  getFormPending,
  getFormPendingByStep,
  listFormPending,
  updateFormPending,
  type WorkflowFormPending,
} from "./db/form-queries.js";
export type { Note, NoteInput, NotePatch, NoteQuery, PinnedNotesQuery } from "./db/note-queries.js";
export {
  createNote,
  deleteNote,
  extendNoteTtl,
  getNote,
  incrementNoteRef,
  listNotes,
  listPinnedNotes,
  sweepExpiredNotes,
  updateNote,
} from "./db/note-queries.js";
export type { Project, ProjectQueryFilter, ProjectQueryResult, ProjectWithCounts } from "./db/project-queries.js";
export {
  createProject,
  deleteProject,
  getDefaultProjectId,
  getProject,
  getProjectByPath,
  queryProjects,
  updateProject,
} from "./db/project-queries.js";
export type { SessionMetaPatch, SessionRow } from "./db/queries.js";
export {
  countSessionMessages,
  deleteSession,
  findIdleSessions,
  getSession,
  getSessionMessages,
  listSessions,
  saveMessage,
  updateSessionMeta,
} from "./db/queries.js";
export type { PauseScope, RunKind, RuntimeSettings } from "./db/runtime-settings-queries.js";
export {
  getRuntimeSettings,
  isAgentsPaused,
  pauseBlocks,
  setAgentsPaused,
} from "./db/runtime-settings-queries.js";
export { initDatabase } from "./db/schema.js";
export type {
  ProjectTask,
  ProjectTaskWithComments,
  TaskComment,
  TaskCommentWithTask,
  TaskQueryFilter,
  TaskQueryResult,
} from "./db/task-queries.js";
export {
  addTaskComment,
  claimBacklogTask,
  createProjectTask,
  deleteProjectTask,
  findStuckCodingTasks,
  getProjectTask,
  listRecentCommentsByAuthor,
  nextBacklogTaskForAssignees,
  queryProjectTasks,
  unblockBudgetTasks,
  updateProjectTask,
} from "./db/task-queries.js";
export type {
  CreateRunInput,
  RecordStepInput,
  UpdateRunInput,
  UpdateStepInput,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepStatus,
  WorkflowTrigger,
} from "./db/workflow-queries.js";
export {
  createWorkflowRun,
  deleteWorkflowRun,
  getWorkflowRun,
  getWorkflowStep,
  listInterruptibleRuns,
  listWorkflowRuns,
  listWorkflowSteps,
  recordWorkflowStep,
  updateWorkflowRun,
  updateWorkflowStep,
} from "./db/workflow-queries.js";
// Deploy-target contract. Types only — the registry and the `tai deploy`
// command live in @tailored-ai/cli, because nothing in the agent runtime needs
// to know how the instance was deployed. See deploy/types.ts.
export type {
  DeployContext,
  DeployPlan,
  DeployResult,
  DeployStatus,
  DeployStep,
  DeployTarget,
  DeployTargets,
} from "./deploy/types.js";
export {
  type AgentCompletedTask,
  type AgentCompletedWorktree,
  type EventBus,
  type RuntimeEvent,
  type RuntimeEventHandler,
  type RuntimeEventMap,
  type RuntimeEventPayload,
  type Subscription,
  TypedEventBus,
} from "./events.js";
export type {
  ExploratoryActivity,
  ExploratoryWorkerOptions,
  SkipReason as ExploratorySkipReason,
} from "./exploratory/worker.js";
export { ExploratoryWorker } from "./exploratory/worker.js";
export { type LoadedExternalAgent, loadExternalAgents } from "./external-agents.js";
export type { CreateToolsOptions } from "./factories.js";
export { createEmbedder, createMetaTools, createProvider, createTools } from "./factories.js";
export { DEFAULT_HOME_DIR_NAME, legacyScratchHome, taiHome, taiHomePath } from "./home.js";
export {
  createHttpRegistryView,
  HTTP_ROUTE_NAMESPACE,
  type HttpMethod,
  type HttpRegistryView,
  type HttpRouteDescriptor,
  type HttpRouteHandler,
  HttpRouteRegistry,
  type ResolvedHttpRoute,
  type TaiHttpRequest,
  type TaiHttpResponse,
} from "./http/registry.js";
export { DEFAULT_MAX_MEDIA_BYTES, DiskMediaStore } from "./media/disk.js";
export type { MediaStore, PutMediaOptions, StoredMedia } from "./media/interface.js";
export { MediaTooLargeError } from "./media/interface.js";
export type { MediaRow } from "./media/queries.js";
export { findExpiredMedia, listMediaRows, totalMediaBytes } from "./media/queries.js";
export type { MediaStoreContext, MediaStoreFactory } from "./media/registry.js";
export { listMediaStoreFactories, registerMediaStoreFactory, resolveMediaStore } from "./media/registry.js";
export { sniffMedia, UnknownMediaTypeError } from "./media/sniff.js";
export type {
  ListQuery as MemoryListQuery,
  MemoryBackend,
  MemoryContent,
  MemoryFragment,
  MemoryHint,
  PreludeContext as MemoryPreludeContext,
  QueryContext as MemoryQueryContext,
} from "./memory/interface.js";
export {
  type MemoryBackendFactory,
  memoryBackendFactoryRegistry,
  registerMemoryBackendFactory,
  resolveMemoryBackend,
} from "./memory/registry.js";
export { SqliteMemoryBackend } from "./memory/sqlite-backend.js";
export {
  DEDUP_DEFAULTS,
  type NotificationCandidate,
  type NotificationDecision,
  type NotificationDedupConfig,
  NotificationGate,
  type NotificationVerdict,
  normalizeForDedup,
  wordSetSimilarity,
} from "./notifications/dedup.js";
export {
  type ChannelRegistryView,
  type CreatePluginContextOptions,
  createPluginContext,
  type EmbeddingRegistryView,
  type MemoryBackendRegistryView,
  type Plugin,
  type PluginConfigValidator,
  type PluginContext,
  type PluginDisposer,
  type PluginMeta,
  type PluginRegistration,
  type ProviderRegistryView,
  type RepoBackendRegistryView,
  type SandboxBackendRegistryView,
  type StepExecutorRegistryView,
  type TaskBackendRegistryView,
  type TimeProviderRegistryView,
  type ToolRegistryView,
  type UiProviderRegistryView,
} from "./plugin-context.js";
export {
  AgentNotifier,
  type AgentNotifierOptions,
  buildNotification,
  emojiForStatus,
} from "./plugins/agent-notifier.js";
export { CoderProjectGuard, type CoderProjectGuardOptions } from "./plugins/coder-project-guard.js";
export { DmMirror, type DmMirrorConfig, type DmMirrorOptions, truncate } from "./plugins/dm-mirror.js";
export { OwnerNotifier, type OwnerNotifierOptions } from "./plugins/owner-notifier.js";
export {
  parseRoomTimestamp,
  RoomAnnouncer,
  type RoomAnnouncerConfig,
  type RoomAnnouncerOptions,
} from "./plugins/room-announcer.js";
export {
  ScopeCreepFlagger,
  type ScopeCreepFlaggerOptions,
  writeScopeWarning,
} from "./plugins/scope-creep-flagger.js";
export {
  composeRecentSummary,
  SessionSummarizer,
  type SessionSummarizerConfig,
  type SessionSummarizerOptions,
} from "./plugins/session-summarizer.js";
export {
  countPriorStalls,
  formatStallComment,
  StallGuard,
  type StallGuardOptions,
} from "./plugins/stall-guard.js";
export { VerifyGate, type VerifyGateOptions } from "./plugins/verify-gate.js";
export { type LoadedPlugin, type LoadPluginsOptions, loadPlugins } from "./plugins.js";
export type {
  ProjectContext,
  ProjectFile,
  ProjectRef,
  ResolveOptions as ProjectResolveOptions,
} from "./projects/resolve.js";
export {
  assertAbsolutePath,
  buildProjectFile,
  findProjectFile,
  PROJECT_FILE,
  readProjectFile,
  resolveProjectFromCwd,
} from "./projects/resolve.js";
export {
  blobToVector,
  cosine,
  type EmbeddingProvider,
  type EmbedOptions,
  type EmbedResult,
  vectorToBlob,
} from "./providers/embedding.js";
export {
  buildOpenAICompatibleProvider,
  type EmbeddingFactory,
  embeddingFactoryRegistry,
  isInlineOpenAICompatible,
  type ProviderFactory,
  type ProviderFactoryResult,
  providerFactoryRegistry,
  registerEmbeddingFactory,
  registerProviderFactory,
} from "./providers/factories.js";
export type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ThinkingLevel,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from "./providers/interface.js";
export type { OpenAIProviderOptions } from "./providers/openai.js";
export { OpenAIProvider } from "./providers/openai.js";
export {
  type OpenAICompatibleEmbeddingOptions,
  OpenAICompatibleEmbeddingProvider,
} from "./providers/openai-embedding.js";
export {
  ProviderHttpError,
  type QuirkLadderOptions,
  QuirkMemo,
  runQuirkLadder,
  WarnOnce,
} from "./providers/quirks.js";
export {
  enableThinkingTemplateMap,
  isThinkingLevel,
  OPENAI_COMPATIBLE_THINKING_DIALECTS,
  reasoningEffortThinkingMap,
  THINKING_LEVELS,
  type ThinkingMapper,
} from "./providers/thinking.js";
export { Registry } from "./registry.js";
export type {
  AgentBody,
  ApprovalGateOptions,
  BodyResolver,
  FetchOptions,
  FetchResult,
  GitResourceSourceOptions,
  GitRunner,
  HttpResourceSourceOptions,
  InstallDecision,
  KbResource,
  LockfileEntry,
  LockfileShape,
  NpmResourceSourceOptions,
  NpmRunner,
  ParseSkillMdOptions,
  PopulateRegistriesOptions,
  PromptBody,
  RegisteredProvider,
  RegistryIndexEntry,
  RegistryIndexShape,
  Resource,
  ResourceDependency,
  ResourceEvent,
  ResourceEventType,
  ResourceKind,
  ResourceListener,
  ResourceLoaderOptions,
  ResourceManifest,
  ResourceOrigin,
  ResourcePermissions,
  ResourceRef,
  ResourceSource,
  ResourceSourceScheme,
  ResourceTrust,
  SkillBody,
  SkillDefinition,
  SkillMdParseResult,
  TaiRegistrySourceOptions,
  TarRunner,
  TriggerKindMeta,
  TrustedPublisher,
  TrustedResource,
  TrustStoreShape,
} from "./resources/index.js";
export {
  AgentRegistry,
  AgentResourceSource,
  ApprovalGate,
  agentDefinitionToManifest,
  BUILTIN_TRIGGER_KINDS,
  clampPermissions,
  DEFAULT_LOCKFILE_NAME,
  defaultLockfilePath,
  FileResourceSource,
  findManifestFile,
  findSkillMdFile,
  GitResourceSource,
  HttpResourceSource,
  hashManifest,
  isSkillMdPath,
  KbRegistry,
  Lockfile,
  ManifestError,
  manifestKey,
  NpmResourceSource,
  PromptRegistry,
  ProviderRegistry,
  parseAgentData,
  parseSkillData,
  parseSkillMd,
  populateBuiltinKbs,
  populateBuiltinProviders,
  populateBuiltinTools,
  populateBuiltinTriggers,
  RegistryDispatchError,
  ResourceLoader,
  ResourceRegistry,
  readManifest,
  readSkillMd,
  renderSkillMd,
  SkillRegistry,
  type StepExecutorContext,
  type StepExecutorFactory,
  StepExecutorRegistry,
  TaiRegistrySource,
  ToolRegistry,
  TriggerKindRegistry,
  TrustStore,
  validateManifest,
} from "./resources/index.js";
export {
  addresses,
  extractLeadingAddressees,
  formatEnvelope,
  isValidIdentityLabel,
  type ParsedEnvelope,
  parseEnvelope,
  renderTranscriptLine,
} from "./rooms/envelope.js";
export {
  enrichRoomMessage,
  IdentityResolver,
  type IdentityResolverOptions,
  type RoomIdentity,
  type RoomIdentityConfig,
} from "./rooms/identities.js";
export { LocalRoomBackend } from "./rooms/local.js";
export {
  getRoomBackend,
  listRoomBackends,
  registerRoomBackend,
  requireRoomBackend,
  roomBackendRegistry,
  unregisterRoomBackend,
} from "./rooms/registry.js";
export { type Deliver, RoomStore, type RoomSubscription, type WakeOn } from "./rooms/store.js";
export {
  type CreateRoomOptions,
  DEFAULT_URGENCY_WINDOW_HOURS,
  formatRoomRef,
  type OutboundRoomMessage,
  parseRoomRef,
  type Room,
  type RoomBackend,
  type RoomCapabilities,
  type RoomMember,
  type RoomMemberKind,
  type RoomMessage,
  type RoomRef,
  type RoomUrgency,
} from "./rooms/types.js";
export { queueKey, WakeQueue, type WakeQueueOptions, type WakeRequest, type WakeTrigger } from "./rooms/wake-queue.js";
export {
  makeRoomSessionKey,
  ROOM_WATCHER_DEFAULTS,
  RoomWatcher,
  type RoomWatcherLimits,
  type RoomWatcherOptions,
  type ScheduledWakeOutcome,
} from "./rooms/watcher.js";
export type { RuntimeOptions } from "./runtime.js";
export { AgentRuntime } from "./runtime.js";
export { ScheduleRunner, type ScheduleRunnerOptions } from "./schedules/runner.js";
export {
  fromDbTime,
  type NewSchedule,
  type ScheduleKind,
  type ScheduleRow,
  type ScheduleStatus,
  ScheduleStore,
  type ScheduleTargetKind,
  toDbTime,
} from "./schedules/store.js";
export {
  describeBooking,
  lateLine,
  recurringLine,
  type WakeContext,
} from "./schedules/wake-context.js";
export {
  formatDistance,
  formatLocal,
  nextOccurrence,
  occurrenceGapSeconds,
  type ParsedWhen,
  parseEvery,
  parseWhen,
  type Recurrence,
  WHEN_FORMS,
  WhenParseError,
} from "./schedules/when.js";
export {
  createEgressPolicy,
  EgressDeniedError,
  type EgressLookup,
  EgressPolicy,
  type EgressPolicyConfig,
  PERMISSIVE_EGRESS_POLICY,
} from "./security/egress-policy.js";
export type { ShellResult } from "./shell.js";
export { runShellCommand, shellEscape } from "./shell.js";
export type { GenerateSuggestionsOptions, Suggestions, SuggestionsRuntime } from "./suggestions.js";
export {
  assembleSuggestionsContext,
  DEFAULT_SUGGESTIONS_PROMPT,
  generateSuggestions,
  parseSuggestions,
} from "./suggestions.js";
export type { TaskEvent } from "./task-watcher.js";
export { detectScopeCreep, detectStall, STALL_COMMENT_PREFIX, TaskWatcher } from "./task-watcher.js";
export {
  assertValidTimeZone,
  type ResolvedTimeProvider,
  registerTimeProviderFactory,
  resolveTimeProvider,
  runtimeTimeProvider,
  systemTimeZone,
  type TimeProvider,
  type TimeProviderFactory,
  timeProviderFactoryRegistry,
} from "./time/provider.js";
export { AdminTool, readRawConfig, writeRawConfigPath } from "./tools/admin.js";
export { AskUserTool } from "./tools/ask-user.js";
export type { BrowserToolConfig } from "./tools/browser.js";
export { BrowserTool } from "./tools/browser.js";
export {
  BrowserMediatorTool,
  type BrowserMediatorToolConfig,
} from "./tools/browser-mediator-tool.js";
export {
  sanitizeAltText,
  sanitizeBrowserOutput,
  sanitizeToolResult,
} from "./tools/browser-output-sanitizer.js";
export { ClaudeCodeTool } from "./tools/claude-code.js";
export { CollectionsTool } from "./tools/collections.js";
export type {
  CommandRules,
  CommandRulesMode,
  EffectiveCommandRules,
} from "./tools/command-allowlist.js";
export { checkCommandAllowlist, checkCommandRules, mergeCommandRules } from "./tools/command-allowlist.js";
export { CustomTool, createCustomTools } from "./tools/custom.js";
export { DelegateTool } from "./tools/delegate.js";
export { DocumentsTool } from "./tools/documents.js";
export { EditTool } from "./tools/edit.js";
export { ExecTool } from "./tools/exec.js";
export { ExtractDocumentTool, type ExtractDocumentToolOptions, extractText } from "./tools/extract-document.js";
export { FactsTool } from "./tools/facts.js";
// Gmail / GoogleCalendar / GoogleDrive moved to @tailored-ai/google-tools.
export type { Tool, ToolContext, ToolResult } from "./tools/interface.js";
export { MdToPdfTool } from "./tools/md-to-pdf.js";
export { MemoryTool } from "./tools/memory.js";
export { ProjectsTool } from "./tools/projects.js";
export { ReadTool } from "./tools/read.js";
export { RecallTool } from "./tools/recall.js";
export {
  formatHits,
  type RecallHit,
  type RecallQueryOptions,
  recallQuery,
  recallQueryAsync,
  type Tier as RecallTier,
  tokenize,
} from "./tools/recall-query.js";
export { ResourceAdminTool, type ResourceAdminToolOptions } from "./tools/resource-admin.js";
export { isTransientError, withRetry } from "./tools/retry.js";
export { RoomTool, type RoomToolOptions } from "./tools/room.js";
export { RunWorkflowTool } from "./tools/run-workflow.js";
export { TaskStatusTool } from "./tools/task-status.js";
export { TaskQueryTool, TasksTool } from "./tools/tasks.js";
export {
  META_TOOL_NAMES,
  registerToolFactory,
  runToolFactories,
  type ToolFactory,
  type ToolFactoryContext,
  toolFactoryRegistry,
} from "./tools/tool-factories.js";
export { WebFetchTool } from "./tools/web-fetch.js";
export { WebSearchTool } from "./tools/web-search.js";
export { WriteTool } from "./tools/write.js";
export {
  CalendarPoller,
  type CalendarPollerOptions,
  type CalendarRegistration,
} from "./triggers/calendar-poll.js";
export { EmailPoller, type EmailPollerOptions } from "./triggers/email-poll.js";
export { FileDropWatcher, type FileDropWatcherOptions } from "./triggers/file-drop.js";
export {
  FinancePoller,
  type FinancePollerOptions,
  type FinanceTriggerConfig,
  parseStooqCsv,
} from "./triggers/finance-poll.js";
export {
  GeofencePoller,
  type GeofencePollerOptions,
  type GeofenceTriggerConfig,
  haversineMeters,
} from "./triggers/geofence-poll.js";
export {
  HomeAssistantPoller,
  type HomeAssistantPollerOptions,
  type HomeAssistantTriggerConfig,
  matchesCondition as matchesHomeAssistantCondition,
} from "./triggers/home-assistant-poll.js";
export {
  parseFeed,
  type RssEntry,
  RssPoller,
  type RssPollerOptions,
  type RssTriggerConfig,
} from "./triggers/rss-poll.js";
export {
  resolveValuePath,
  SensorPoller,
  type SensorPollerOptions,
  type SensorTriggerConfig,
} from "./triggers/sensor-poll.js";
export {
  WeatherPoller,
  type WeatherPollerOptions,
  type WeatherTriggerConfig,
} from "./triggers/weather-poll.js";
export { expandRefs, expandRefsInArgs, maskRef } from "./vault/ref-parser.js";
export { createVaultTable } from "./vault/schema.js";
export {
  formatVaultKey,
  getVaultKey,
  parseVaultKey,
  type VaultKey,
  type VaultRecord,
  vaultDelete,
  vaultGet,
  vaultIsFetcher,
  vaultList,
  vaultSet,
} from "./vault/vault.js";
export {
  type AnalyticsSummary,
  type AnalyticsWindow,
  type PerWorkflowMetrics,
  perWorkflowMetrics,
  type StepHotspot,
  stepHotspots,
  summarize as summarizeWorkflowAnalytics,
  type TokensByWorkflow,
  tokenUsageByWorkflow,
} from "./workflows/analytics.js";
export { populateBuiltinExecutors } from "./workflows/builtin-executors.js";
export {
  CancelledError,
  DeadlineError,
  type EngineEvent,
  type EngineOptions,
  type StepContext,
  type StepExecutor,
  type StepResult,
  WorkflowEngine,
  WorkflowError,
} from "./workflows/engine.js";
export { AgentRunExecutor } from "./workflows/executors/agent-run.js";
export type { ChannelMessageExecutorOptions } from "./workflows/executors/channel-message.js";
export { ChannelMessageExecutor } from "./workflows/executors/channel-message.js";
export { FormExecutor, type FormExecutorOptions } from "./workflows/executors/form.js";
export { HttpRequestExecutor } from "./workflows/executors/http-request.js";
export { LoopExecutor } from "./workflows/executors/loop.js";
export type { EmailSender, NotifyExecutorOptions } from "./workflows/executors/notify.js";
export { NotifyExecutor } from "./workflows/executors/notify.js";
export { ParallelExecutor } from "./workflows/executors/parallel.js";
export { ShellExecutor } from "./workflows/executors/shell.js";
export { ToolCallExecutor } from "./workflows/executors/tool-call.js";
export { TriggerWorkflowExecutor } from "./workflows/executors/trigger-workflow.js";
export { WorktreeExecutor } from "./workflows/executors/worktree.js";
export { evaluateExpression } from "./workflows/expression.js";
export { createWorkflowEngine } from "./workflows/factory.js";
export {
  FormCancelledError,
  type FormEvent,
  type FormPendingEvent,
  type FormRegisterResult,
  FormRegistry,
  type FormSubmittedEvent,
  FormTimeoutError,
  type RegisterFormInput,
} from "./workflows/form-registry.js";
export {
  type InputValidationResult,
  validateInputsSchema,
  validateWorkflowInputs,
} from "./workflows/inputs.js";
export {
  type LoadResult,
  loadWorkflowsFromDir,
  parseWorkflow,
  resolveWorkflowsDir,
  validateWorkflow,
} from "./workflows/loader.js";
export { FileLogStore } from "./workflows/logs.js";
export { WorkflowRegistry } from "./workflows/registry.js";
export { lookup, resolveString, resolveValue, type Scope } from "./workflows/scope.js";
export {
  deleteSecret,
  getSecret,
  getSecretsKey,
  listSecrets,
  loadSecretsMap,
  type SecretRecord,
  setSecret,
} from "./workflows/secrets.js";
export { KeyedSemaphore, Semaphore } from "./workflows/semaphore.js";
export {
  WorkflowTriggerCoordinator,
  type WorkflowTriggerCoordinatorPollers,
} from "./workflows/trigger-coordinator.js";
export type {
  AgentRunStep,
  ConditionStep,
  LoopStep,
  OnErrorPolicy,
  ParallelStep,
  RegisteredWorkflow,
  RetryPolicy,
  ShellStep,
  StepType,
  ToolCallStep,
  WorkflowDefinition,
  WorkflowExecutionMode,
  WorkflowInputSchema,
  WorkflowInputsSchema,
  WorkflowInputType,
  WorkflowStepDef,
} from "./workflows/types.js";
export { defineWorkflow } from "./workflows/types.js";
export {
  getVersion,
  listVersions,
  type RecordVersionInput,
  recordVersion,
  type WorkflowVersion,
} from "./workflows/versions.js";
