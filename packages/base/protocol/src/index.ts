// @mediabase/protocol — NEUTRAL contracts: the vocabulary a capability-agnostic host
// understands. Product protocol packages (e.g. @avstudio/protocol) re-export this
// and add domain contracts, so capability packages can import one package while
// the base stays free of any product concept.
//
// Schema/JSON-Schema types are imported type-only, so nothing schema-related
// reaches the browser bundle.

import type { JsonSchema, Schema } from '@mediabase/schema'

// JSON-RPC + coded errors are part of the neutral vocabulary.
export * from '@mediabase/rpc'

// ---- runtime plugin manager (E: hot load) ---------------------------------

export interface PluginDescriptor {
  id: string
  description: string
  state: 'loaded' | 'unloaded' | 'error'
}

export interface PluginProbe {
  id: string
  state: 'loaded' | 'unloaded' | 'error'
  provides: string[]
  /** True when every declared service is currently present on ctx. */
  provided: boolean
  /**
   * Human-readable confinement report for a process-isolated plugin (enforced
   * layers + what could NOT be enforced). Absent for in-process plugins, which
   * have no boundary to report: `isolation: 'process'` says a child exists, not
   * that anything is restricted.
   */
  confinement?: string | null
  /** True when at least one confinement layer is actually enforced. */
  confined?: boolean
}

/** The `plugins` service published by the host plugins plugin. */
export interface PluginService {
  list(): Promise<PluginDescriptor[]>
  load(id: string): Promise<PluginDescriptor>
  unload(id: string): Promise<PluginDescriptor>
  reload(id: string): Promise<PluginDescriptor>
  probe(id: string): Promise<PluginProbe>
}

// ---- LLM agent (C1) --------------------------------------------------------

export interface AgentStep {
  /** Tool name the model chose, e.g. "python.run". */
  name: string
  /** Args the model produced (JSON). */
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface AgentResult {
  ok: boolean
  /** The model's final answer text. */
  answer: string
  steps: AgentStep[]
}

/** The `agent` service published by the host agent plugin. */
export interface AgentService {
  run(o: { prompt: string; maxSteps?: number }): Promise<AgentResult>
}

// ---- tool registry (route-B: capabilities register, cores only consume) ----

/**
 * One registered tool. `params` is an @mediabase/schema (schemastery) schema: the
 * registry validates arguments with it and derives the OpenAI-style JSON Schema
 * the LLM agent needs, so a tool declares its surface exactly once.
 */
export interface RegistryTool {
  name: string
  description: string
  params?: Schema<any, ToolArgs>
  execute(args: ToolArgs): unknown | Promise<unknown>
}

/** Validated tool arguments (defaults already applied by the schema). */
export type ToolArgs = Record<string, unknown>

/** Public view of a registered tool (no execute body; JSON Schema for the LLM). */
export interface RegistryToolView {
  name: string
  description: string
  /** OpenAI-style JSON schema fragment, derived from the tool's `params`. */
  parameters?: Record<string, unknown>
  /** Human/TS-readable signature of the same schema. */
  signature?: string
}

/** The `registry` service published by the host registry plugin. */
export interface RegistryService {
  /** Register a tool; returns a disposer that removes it. */
  register(tool: RegistryTool): () => void
  list(): RegistryToolView[]
  run(name: string, args: ToolArgs): Promise<unknown>
  has(name: string): boolean
}

// ---- capability composition (what one capability package exposes to a host) --

/** Environment as seen by a capability (no Node types: this file is client-safe). */
export type CapabilityEnv = Record<string, string | undefined>

// (The old `CapabilityResolveConfig` seam is gone with the in-code capability table: a
// capability's env vocabulary is stated by the composition ROW that reads it, and its
// `Config` schema is what such a row must satisfy.)

// ---- data plane: byte streams (push) ---------------------------------------

/** One frame delivered on a stream channel: metadata + raw bytes. */
export interface StreamFrameMeta {
  /** Channel name (`preview.rgb`, …). */
  channel: string
  /** Monotonic per-channel frame counter — lets a client detect drops. */
  seq: number
  /** Payload byte length. */
  bytes: number
  /** Free-form per-channel fields (width/height/format/pts for frames). */
  [key: string]: unknown
}

/**
 * Transport-side sink handed to a producer when a client subscribes. The
 * producer never knows whether the bytes go over a WS stream, a shared buffer or
 * something else — that is the gateway's business.
 */
export interface StreamSink {
  /** Deliver one frame. May be DROPPED by the transport under backpressure. */
  send(meta: Omit<StreamFrameMeta, 'seq' | 'bytes'>, body: Uint8Array): boolean
  /** Subscribers currently listening (0 = do not encode/emit at all). */
  subscribers(): number
  /** Frames dropped so far by this sink (backpressure accounting). */
  dropped(): number
}

/**
 * A stream channel a capability publishes on. `attach` is called when the first
 * subscriber arrives and its disposer when the last leaves, so a producer can
 * avoid all work while nobody is watching.
 */
export interface StreamChannel {
  name: string
  description?: string
  attach(sink: StreamSink): () => void
}

/** Introspection view of a registered channel. */
export interface StreamChannelView {
  name: string
  description?: string
  subscribers: number
  dropped: number
}

// ---- control-plane protocol ------------------------------------------------

/**
 * Version of the CONTROL PLANE (WS JSON-RPC method names/shapes + the stream
 * envelope). Bump it on a breaking change and the client refuses to operate
 * against a mismatched host instead of failing method by method. Mirrors the
 * engine's `hello` handshake at the process boundary.
 */
export const CONTROL_PROTOCOL_VERSION = 1

/** What `server.info` (the host's handshake) reports. */
export interface HostInfo {
  protocol: number
  host: string
  port: number
  distIndex: string
  /** Live stream subscribers per channel. */
  streams?: Record<string, number>
  /** Access policy in force, so a client can explain a refusal. */
  acl?: { readonly?: boolean; allow?: string[]; deny?: string[] }
}

// ---- control-plane API registry + capability manifests --------------------

/** Introspection view of one registered API method (what `api.list` returns). */
export interface ApiMethodView {
  name: string
  description: string
  /** True when calling it changes host state (used by read-only mode). */
  mutates?: boolean
  /** TS-ish parameter signature, e.g. `{ file: string, time?: number }`. */
  signature: string
  /** Parameter JSON Schema, for form generation or an agent bridge. */
  jsonSchema?: JsonSchema
}

/**
 * What one capability package contributes, declared by the capability itself.
 * `capabilities.verify` cross-checks these claims against what actually
 * registered, so a capability that forgets to expose something fails loudly at
 * boot instead of silently missing a method.
 */
export interface CapabilityManifest {
  id: string
  title: string
  description: string
  services?: string[]
  api?: string[]
  tools?: string[]
  /** Host event names this capability emits; the server forwards them to clients. */
  events?: string[]
}

export interface CapabilityReport {
  id: string
  title: string
  ok: boolean
  missing: { services: string[]; api: string[]; tools: string[] }
}

// ---- settings (host-side persisted config, e.g. LLM key) ------------------

/** The `settings` service published by the host settings plugin. */
export interface SettingsService {
  /** All persisted settings as a flat key->JSON map. */
  list(): Promise<Record<string, unknown>>
  get(key: string): Promise<unknown>
  /** Persist one key; empty string/undefined deletes it. */
  set(key: string, value: unknown): Promise<void>
}
