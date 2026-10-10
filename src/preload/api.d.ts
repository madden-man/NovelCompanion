import type { Api } from '../shared/ipc';

declare global {
  interface Window {
    readonly api: Api;
  }
}

export {};
