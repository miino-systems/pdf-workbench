/**
 * Minimal observable store. No framework: the UI subscribes and re-renders
 * the affected section. Kept deliberately small (spec §1: no large UI framework).
 */
export type Listener<S> = (state: S, prev: S) => void;

export class Store<S extends object> {
  private state: S;
  private listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  /** Shallow-merge `patch` into the state and notify listeners. */
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void {
    const prev = this.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    this.state = { ...prev, ...p };
    for (const l of this.listeners) l(this.state, prev);
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
