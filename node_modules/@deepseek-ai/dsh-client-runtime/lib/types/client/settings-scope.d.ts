/** Host-backed settings-namespace synchronization for browser plugins. */
import type { Context } from '@deepseek-ai/cordis';
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
/** Client-side sync state of one settings namespace. */
export interface SettingsScopeSnapshot<T> {
    /**
     * `loading` until the first accepted section, `ready` while one stands, and
     * `unavailable` when the namespace is not exposed to this client or the
     * connection keeps preferences process-local (memory mode).
     */
    status: 'loading' | 'ready' | 'unavailable';
    /** Last accepted schema-resolved section; undefined before the first acceptance. */
    value: T | undefined;
    /** Namespace revision fencing the next write; undefined before the first Host view. */
    revision: number | undefined;
    /** Whether the Host document accepts writes; memory mode never does. */
    writable: boolean;
    /** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
    mode: 'host' | 'memory';
}
/** Domain-owned description of one settings namespace consumed by a browser plugin. */
export interface SettingsScopeSpec<T> {
    /** Settings namespace registered by the owning Host plugin. */
    namespace: string;
    /**
     * Narrow one wire section; undefined keeps the last accepted value. The
     * default validates the section against the namespace's own serialized wire
     * schema, so domains add a decoder only to narrow beyond that schema.
     */
    decode?: (section: unknown) => T | undefined;
}
/**
 * Reactive owner handle over one namespace's durable section — the browser
 * mirror of the Host-side `SettingsScope` owner seam. Domain services read
 * and observe the snapshot and route explicit user choices through `set`.
 */
export interface SettingsScope<T> {
    /** @returns the current sync snapshot (stable reference until the next change). */
    getSnapshot(): SettingsScopeSnapshot<T>;
    /**
     * Observe snapshot replacements.
     * @param listener - invoked after each snapshot change.
     * @returns the disposer removing this listener.
     */
    subscribe(listener: () => void): () => void;
    /**
     * Queue one field write. Rapid writes preserve mutation order, each carries
     * the latest known namespace revision, and only the latest settlement may
     * publish; a rejected or failed latest write reloads Host state instead.
     * @param field - scalar field inside the namespace section.
     * @param value - JSON-shaped value selected by the user.
     * @returns settlement after the write and any latest-write recovery read.
     */
    set(field: string, value: unknown): Promise<void>;
}
type SettingsFace = Pick<IApiClient, 'settings'>;
/**
 * Serializes one namespace's Host reads and writes behind a snapshot store.
 * Reads never block plugin activation; writes carry the latest known
 * namespace revision and teardown waits for the operation already crossing
 * the wire.
 */
export declare class SettingsScopeController<T> implements SettingsScope<T> {
    private readonly api;
    private readonly spec;
    private readonly persistence;
    private readonly store;
    private tail;
    private readGeneration;
    private writeGeneration;
    private disposed;
    /**
     * @param api - settings wire face.
     * @param spec - namespace identity and optional narrowing decoder.
     * @param persistence - remote browsers remain process-local because settings RPCs are loopback-only.
     */
    constructor(api: SettingsFace, spec: SettingsScopeSpec<T>, persistence?: 'host' | 'memory');
    /** @returns the current sync snapshot (stable reference until the next change). */
    getSnapshot(): SettingsScopeSnapshot<T>;
    /**
     * Observe snapshot replacements.
     * @param listener - invoked after each snapshot change.
     * @returns the disposer removing this listener.
     */
    subscribe(listener: () => void): () => void;
    /**
     * Queue a Host refresh; a newer read or user write suppresses stale publication.
     * @returns settlement after the queued read completes or is skipped.
     */
    load(): Promise<void>;
    /**
     * Queue one field write; see {@link SettingsScope.set} for the ordering,
     * revision, and recovery contract.
     * @param field - scalar field inside the namespace section.
     * @param value - JSON-shaped value selected by the user.
     * @returns settlement after the write and any latest-write recovery read.
     */
    set(field: string, value: unknown): Promise<void>;
    /**
     * Stop queued operations and wait for the current wire call to settle.
     * @returns settlement after the controller reaches quiescence.
     */
    dispose(): Promise<void>;
    private enqueue;
    private read;
    private accept;
    private decode;
}
/**
 * Bind one namespace scope to settings and connection invalidations on the
 * caller's plugin lifecycle. Listeners exist before the initial background
 * read starts, so activation never blocks on the settings transport.
 * @param ctx - owning browser plugin context.
 * @param spec - domain-owned namespace contract.
 * @returns the bound scope consumed by the domain's services and rows.
 */
export declare function bindSettingsScope<T>(ctx: Context, spec: SettingsScopeSpec<T>): SettingsScope<T>;
export {};
//# sourceMappingURL=settings-scope.d.ts.map