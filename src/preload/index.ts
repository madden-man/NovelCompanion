import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import {
  events,
  isChannel,
  isEventName,
  parseCallContext,
  parseRequest,
  parseResponse,
  wireChannel,
  wireEvent,
} from '../shared/ipc';
import type {
  Api,
  CallContext,
  Channel,
  EventName,
  EventPayload,
  Request,
  Response,
} from '../shared/ipc';

/**
 * Generic invoke: validates the request before sending and the response after.
 * The context (A57: the bible a write was made in) travels beside the request.
 */
async function invoke<C extends Channel>(
  channel: C,
  request: Request<C>,
  context?: CallContext,
): Promise<Response<C>> {
  if (!isChannel(channel)) throw new Error(`Unknown channel: ${String(channel)}`);
  const parsed = parseRequest(channel, request);
  const extra = context === undefined ? [] : [parseCallContext(context)];
  const raw: unknown = await ipcRenderer.invoke(wireChannel(channel), parsed, ...extra);
  return parseResponse(channel, raw);
}

function on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
  if (!isEventName(event)) throw new Error(`Unknown event: ${String(event)}`);
  const wrapped = (_e: IpcRendererEvent, payload: unknown) => {
    const result = events[event].safeParse(payload);
    if (result.success) listener(result.data as EventPayload<E>);
  };
  ipcRenderer.on(wireEvent(event), wrapped);
  return () => {
    ipcRenderer.removeListener(wireEvent(event), wrapped);
  };
}

const api: Api = { invoke, on };

contextBridge.exposeInMainWorld('api', api);
