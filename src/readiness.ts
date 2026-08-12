

type AppState = 'starting' | 'ready' | 'shutting_down';

let state: AppState = 'starting';

export function getState(): AppState {
  return state;
}

export function setReady(): void {
  state = 'ready';
}

export function setShuttingDown(): void {
  state = 'shutting_down';
}

export function isReady(): boolean {
  return state === 'ready';
}