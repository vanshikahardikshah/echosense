import type { ClientMsg, ServerMsg } from '../net/protocol';

export type HubStatus = 'idle' | 'connecting' | 'open' | 'closed';

/** WebSocket link to the EchoSense hub, with automatic reconnection. */
export class HubClient {
  private ws: WebSocket | null = null;
  private url = '';
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  status: HubStatus = 'idle';
  nodeId: string | undefined;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: HubStatus) => void = () => {};

  constructor(
    private readonly role: 'node' | 'console',
    private readonly name: string,
    private readonly extra: () => Partial<Extract<ClientMsg, { type: 'hello' }>> = () => ({}),
  ) {
    if (role === 'node') {
      try {
        this.nodeId = localStorage.getItem('echosense.nodeId') ?? undefined;
      } catch {
        /* private mode */
      }
    }
  }

  static defaultUrl(): string | null {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  connect(url: string): void {
    this.url = url;
    this.manualClose = false;
    this.open();
  }

  private open(): void {
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setStatus('closed');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      this.send({
        type: 'hello',
        role: this.role,
        name: this.name,
        device: navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.platform || 'browser',
        nodeId: this.nodeId,
        ...this.extra(),
      });
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as ServerMsg;
        if (m.type === 'welcome') {
          this.nodeId = m.nodeId;
          // Keep the same identity across reloads, so the room map and labels stay attached.
          if (this.role === 'node') {
            try {
              localStorage.setItem('echosense.nodeId', m.nodeId);
            } catch {
              /* private mode */
            }
          }
        }
        this.onMessage(m);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.setStatus('closed');
      if (!this.manualClose) {
        this.retry = Math.min(this.retry + 1, 4);
        this.timer = setTimeout(() => this.open(), 500 * 2 ** this.retry);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Reconnect immediately if the link is down (after the page comes back to the foreground). */
  reconnectNow(): void {
    if (!this.url || this.manualClose || this.status === 'open' || this.status === 'connecting') return;
    this.retry = 0;
    this.open();
  }

  close(): void {
    this.manualClose = true;
    this.ws?.close();
  }

  private setStatus(s: HubStatus): void {
    this.status = s;
    this.onStatus(s);
  }
}
