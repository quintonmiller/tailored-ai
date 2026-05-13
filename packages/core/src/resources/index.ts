export type {
  BodyResolver,
  ResourceLoaderOptions,
} from "./loader.js";
export { ResourceLoader } from "./loader.js";
export type {
  FetchOptions,
  FetchResult,
  Resource,
  ResourceDependency,
  ResourceEvent,
  ResourceEventType,
  ResourceKind,
  ResourceListener,
  ResourceManifest,
  ResourceOrigin,
  ResourcePermissions,
  ResourceRef,
  ResourceSource,
  ResourceSourceScheme,
  ResourceTrust,
} from "./interface.js";
export { ResourceRegistry } from "./registry.js";
export { FileResourceSource } from "./sources/file.js";
export { AgentResourceSource } from "./sources/agent.js";
export { HttpResourceSource, type HttpResourceSourceOptions } from "./sources/http.js";
export { GitResourceSource, type GitResourceSourceOptions, type GitRunner } from "./sources/git.js";
export { NpmResourceSource, type NpmResourceSourceOptions, type NpmRunner, type TarRunner } from "./sources/npm.js";
export {
  TaiRegistrySource,
  RegistryDispatchError,
  type RegistryIndexEntry,
  type RegistryIndexShape,
  type TaiRegistrySourceOptions,
} from "./sources/registry-index.js";
export {
  Lockfile,
  DEFAULT_LOCKFILE_NAME,
  defaultLockfilePath,
  type LockfileEntry,
  type LockfileShape,
} from "./lockfile.js";
export { ManifestError, findManifestFile, manifestKey, readManifest, validateManifest } from "./manifest.js";
export { ToolRegistry } from "./tool-registry.js";
export { ProviderRegistry, type RegisteredProvider } from "./provider-registry.js";
export { populateBuiltinTools, populateBuiltinProviders, type PopulateRegistriesOptions } from "./builtins.js";
export { SkillRegistry, parseSkillData, type SkillBody, type SkillDefinition } from "./skill.js";
export {
  AgentRegistry,
  parseAgentData,
  agentDefinitionToManifest,
  type AgentBody,
} from "./agent.js";
export {
  BundleRegistry,
  parseBundleData,
  discoverBundleMembers,
  activateBundleMember,
  deactivateBundleMember,
  uninstallBundleCascade,
  type ActivateMemberOptions,
  type BundleBody,
  type BundleMember,
  type BundleOptions,
} from "./bundle.js";
export {
  findSkillMdFile,
  isSkillMdPath,
  parseSkillMd,
  readSkillMd,
  renderSkillMd,
  type ParseSkillMdOptions,
  type SkillMdParseResult,
} from "./skill-md.js";
export { StepExecutorRegistry } from "./step-executor-registry.js";
export { KbRegistry, populateBuiltinKbs, type KbResource } from "./kb-registry.js";
export { PromptRegistry, type PromptBody } from "./prompt-registry.js";
export { TrustStore, hashManifest, type TrustDecision, type TrustStoreShape, type TrustedPublisher, type TrustedResource } from "./trust.js";
export {
  ApprovalGate,
  clampPermissions,
  type ApprovalGateOptions,
  type InstallDecision,
} from "./approval-gate.js";
export {
  TriggerKindRegistry,
  BUILTIN_TRIGGER_KINDS,
  populateBuiltinTriggers,
  type TriggerKindMeta,
} from "./trigger-registry.js";
