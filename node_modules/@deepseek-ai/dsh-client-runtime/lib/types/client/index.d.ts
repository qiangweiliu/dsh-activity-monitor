/** Browser runtime services for slots, sessions, workspaces, and connection-stream delivery. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client';
import type { TypeRTContext } from '@deepseek-ai/dsh-type-meta';
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionListState } from './sessions/service.ts';
import type { ConversationSnapshot } from './sessions/conversation.ts';
import type { UseProjection } from './sessions/projection-store.ts';
export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
export { SlotsService } from './slots.ts';
export { ConversationEventRegistry } from './conversation/event-registry.ts';
export { ConversationViewRegistry } from './conversation/view-registry.ts';
export { ConversationNodeAssembler } from './sessions/conversation-assembler.ts';
export { ConversationLocationIndex } from './sessions/conversation-location-index.ts';
export { conversationContextKey } from './contract/conversation.ts';
export type { ChatConversationViewNode, ConversationContextReader, ConversationEventInput, ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataStore, ConversationStepDataMap, ConversationLocation, ConversationMatch, ConversationMatchResult, ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext, ConversationPublication, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode, StepLocation, TurnLocation, } from './contract/conversation.ts';
export type { ConversationRuntime } from './sessions/conversation-assembler.ts';
export type { RootOwnerProps } from './slots.ts';
export { SessionCreateError, SessionsService, scopeOf, workspaceTitleOf } from './sessions/service.ts';
export { SessionHistoryService } from './session-history/service.ts';
export { indexSubagentDescendants } from './sessions/subagent-lineage.ts';
export type { SubagentDescendantSummary } from './sessions/subagent-lineage.ts';
export { SessionProvideChannel } from './sessions/provide.ts';
export type { SessionProvideChannelHost } from './sessions/provide.ts';
export { createScope } from './agents/scope.ts';
export type { AgentScopeHandle } from './agents/scope.ts';
export { DirectoryBrowseError, WorkspaceCreateError, WorkspacesService } from './workspaces/service.ts';
export { bindSettingsScope, SettingsScopeController } from './settings-scope.ts';
export type { SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec } from './settings-scope.ts';
export { resolveWorkspacePath } from './workspaces/path.ts';
export type { Session } from './sessions/session.ts';
export type { ISession, ProjectionsFace, SessionFace } from './contract/session.ts';
export type { ISessionHistory, SessionHistoryFace, SessionHistorySnapshot, } from './contract/session-history.ts';
export type { AgentContext, ISessions } from './contract/sessions.ts';
export type { IWorkspaces } from './contract/workspaces.ts';
export type { SessionBinding, SessionListState, SessionProvideContribution, SessionProvideDescriptor, SessionSummary, } from './sessions/service.ts';
export type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './sessions/manager.ts';
export type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client';
export type { WorkspaceListPhase } from './workspaces/manager.ts';
export type { WorkspaceListState } from './workspaces/service.ts';
export type { DirectoryEntry, DirectoryListing, WorkspaceId, WorkspaceView, } from '@deepseek-ai/dsh-client-connection/client';
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts';
export type { EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore, } from './contract/store.ts';
export type { AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig, AssistantTiming, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot, CommandNode, CompactionSummaryNode, ComposerPhase, ContextMessageNode, ConversationNode, ConversationSnapshot, ModelRetryNode, QueuedMessage, LegacyConversationSlice, PartialAssistant, RunningToolCall, SteeringMessageNode, TodoItem, ToolCallBlock, ToolResultNode, TurnErrorNode, UnknownSurfaceNode, UserMessageNode, } from './sessions/conversation.ts';
export { EMPTY_CHAT_SNAPSHOT, toAssistantBlock, toAssistantBlocks } from './sessions/conversation.ts';
export { emptyAssistantBlock } from './sessions/partial.ts';
export { isTokenDelta } from './sessions/assistant-timing.ts';
export { contextForm, contextProvenance } from './sessions/context-provenance.ts';
export { displayFailureMessage } from './sessions/failure-display.ts';
export type { ConversationContext, ConversationContextOriginKind, } from './sessions/conversation-context.ts';
export type { ContextProvenanceView, ContextRole, KnownContextForm, } from './sessions/context-provenance.ts';
export type { ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView, } from './sessions/request-inspection.ts';
export type { ConversationHistoryProjection } from './session-history/history-fold.ts';
export type { SessionHistoryInspection } from './sessions/history.ts';
export { PendingWait } from './sessions/pending.ts';
export type { PendingInteraction, PendingInteractionStatus, PendingKind, PendingPayloads, } from './sessions/pending.ts';
export type { ProjectionsBaseline, ProjectionValueStore, SessionProjectionMap, UseProjection, } from './sessions/projection-store.ts';
export type { SessionId } from '@deepseek-ai/dsh-client-connection/client';
/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context;
declare module '@deepseek-ai/dsh-type-meta' {
    interface TypeRTContextMap {
        /** Client Agent scope identity; the agent and session share one wire id. */
        agent: TypeRTContext<SessionId>;
    }
}
/** The conversation-snapshot selector hook supplied to session-scoped UI entries. */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    /**
     * Session standard kit, real members (ui-slots declares the empty seat;
     * the runtime — where the subjects live — merges the concrete types):
     * every session-scope slot component receives these from the framework.
     */
    interface SessionStandardProps {
        useSession: SnapshotSelectorHook<ConversationSnapshot>;
        /** The framework-resolved session id (owners never pass it). */
        sessionId: SessionId;
        /** The fifth framework hook seat: key-addressed projection reader (undefined = capability absent). */
        useProjection: UseProjection;
    }
    /** Standard kit for slots that remain mounted while current session changes. */
    interface SessionMaybeStandardProps {
        useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>;
        /** Current session id; absent in the no-session state. */
        sessionId: SessionId | undefined;
        /** Key-addressed projection reader; every key reads absent while no session is current. */
        useProjection: UseProjection;
    }
    /** Props injected into every global slot component. */
    interface GlobalStandardProps {
        useSessions: SnapshotSelectorHook<SessionListState>;
        /** Selector hook over real Workspaces and their independent baseline lifecycle. */
        useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * A slot's definition or registration set changed.
         * @mode emit
         * @param key - the mutated SlotMap key.
         */
        'slots/changed'(key: string): void;
        /**
         * The host command registry changed (host/commands-changed passthrough).
         * Pure invalidation signal: subscribers refetch `command.list` in the
         * background rather than diffing.
         * @mode emit
         */
        'commands/changed'(): void;
        /**
         * One settings namespace's resolved value changed on the host
         * (host/settings-changed passthrough). Subscribers refetch
         * `settings.describe`; the frame carries no values.
         * @mode emit
         * @param ns - the namespace whose resolved value changed.
         */
        'settings/changed'(ns: string): void;
        /**
         * One credential reference's state changed on the host
         * (host/credentials-changed passthrough). The ref is an
         * environment-variable NAME — never a value.
         * @mode emit
         * @param ref - the reference whose configured state changed.
         */
        'credentials/changed'(ref: string): void;
        /**
         * The host provider topology changed (host/models-changed passthrough).
         * Subscribers refetch `llm.providers`/`llm.models`/`session.models`.
         * @mode emit
         */
        'models/changed'(): void;
        /**
         * One session's agent preset changed (host/session-preset-changed
         * passthrough), so everything its composition decides — the command
         * catalog, the skill catalog — is stale for that session and no other.
         * Every connected client observes it, not only the one that issued the
         * switch. Subscribers refetch their own session-keyed caches; the frame
         * carries no catalog.
         * @mode emit
         * @param sessionId - the session whose composition changed.
         * @param agentPreset - the preset it now runs.
         */
        'session/preset-changed'(sessionId: SessionId, agentPreset: string): void;
        /**
         * A connection generation was (re-)established. Wire-derived caches must
         * treat their state as stale and repull (commands directory; the queue
         * mirrors reset themselves through the session resync path).
         * @mode emit
         */
        'connection/reset'(): void;
    }
    interface Context {
        slots: import('./slots.ts').SlotsService;
        /** Event-to-business-Context Definition registry. */
        conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry;
        /** Per-target Conversation snapshot builder registry. */
        conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry;
        /** The outward face only; the concrete service stays inside the runtime. */
        sessions: import('./contract/sessions.ts').ISessions;
        /** Read-only history sources isolated from Chat sessions and workspace state. */
        sessionHistory: import('./contract/session-history.ts').ISessionHistory;
        /** The outward face only; the concrete service stays inside the runtime. */
        workspaces: import('./contract/workspaces.ts').IWorkspaces;
    }
}
/** Required services: the wire handle and Client TypeRT registry. */
export declare const inject: string[];
/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map