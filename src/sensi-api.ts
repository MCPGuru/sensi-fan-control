import axios from 'axios';
import WebSocket from 'ws';
import { Logging } from 'homebridge';

export interface DeviceStatePacket {
  icd_id: string;
  registration?: { name?: string; product_type?: string };
  state?: any;
  capabilities?: Record<string, any>;
}

export type DeviceUpdateListener = (device: DeviceStatePacket) => void;
export type TokenPersistListener = (refreshToken: string) => void;

export class SensiAPI {
  private readonly oauthUrl = 'https://oauth.sensiapi.io/token';
  private readonly wsUrl = 'wss://rt.sensiapi.io/thermostat/?transport=websocket';

  private refreshToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private accessToken: string | null = null;
  private ws: WebSocket | null = null;
  private listeners: Set<DeviceUpdateListener> = new Set();
  private tokenListeners: Set<TokenPersistListener> = new Set();
  private reconnecting = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    refreshToken: string,
    private readonly log: Logging,
    clientId?: string,
    clientSecret?: string
  ) {
    this.refreshToken = refreshToken;
    // Refresh tokens are bound to the OAuth client that issued them, so a token
    // captured from the iOS app cannot be redeemed as the 'fleet' web client.
    this.clientId = clientId || 'fleet';
    this.clientSecret =
      clientSecret || 'JLFjJmketRhj>M9uoDhusYKyi?zUyNqhGB)H2XiwLEF#KcGKrRD2JZsDQ7ufNven';
  }

  onTokenRefreshed(listener: TokenPersistListener): void {
    this.tokenListeners.add(listener);
  }

  async authenticate(): Promise<void> {
    const form = new URLSearchParams();
    form.set('client_id', this.clientId);
    form.set('client_secret', this.clientSecret);
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', this.refreshToken);

    const resp = await axios.post(this.oauthUrl, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: '*/*' },
      timeout: 10000,
    });

    this.accessToken = resp.data.access_token;

    // Sensi rotates the refresh token on every exchange. The upstream plugin kept the
    // new one in memory only, so a restart after rotation would fail to authenticate.
    if (resp.data.refresh_token && resp.data.refresh_token !== this.refreshToken) {
      this.refreshToken = resp.data.refresh_token;
      for (const l of this.tokenListeners) {
        l(this.refreshToken);
      }
    }
    this.log.info('[Sensi] OAuth success: access token acquired');
  }

  private teardownSocket(): void {
    if (!this.ws) {
      return;
    }
    const old = this.ws;
    this.ws = null;
    old.removeAllListeners();
    try {
      old.terminate();
    } catch {
      /* already dead */
    }
  }

  async connect(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (!this.accessToken) {
      await this.authenticate();
    }

    this.teardownSocket();

    const ws = new WebSocket(this.wsUrl, { headers: { Authorization: `bearer ${this.accessToken}` } });
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('[Sensi] WebSocket connected');
      this.startKeepAlive();
    });
    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', () => this.scheduleReconnect('closed'));
    ws.on('error', (err) => {
      this.log.error('[Sensi] WebSocket error', err);
      this.scheduleReconnect('error');
    });
  }

  private async handleMessage(raw: WebSocket.Data): Promise<void> {
    const msg = typeof raw === 'string' ? raw : raw.toString('utf-8');

    if (msg.startsWith('44')) {
      this.log.warn('[Sensi] Token expired. Refreshing...');
      this.scheduleReconnect('token expired');
      return;
    }

    if (!msg.startsWith('42')) {
      return;
    }

    try {
      const payload = JSON.parse(msg.slice(2));
      const event = payload[0];
      const data = payload[1];

      if (event === 'state' && Array.isArray(data)) {
        for (const device of data as DeviceStatePacket[]) {
          for (const l of this.listeners) {
            l(device);
          }
        }
      }
    } catch (e) {
      this.log.error('[Sensi] Failed to parse WS message', e);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnecting || this.closed) {
      return;
    }
    this.reconnecting = true;
    this.stopKeepAlive();
    this.teardownSocket();
    this.log.warn(`[Sensi] Scheduling reconnect due to ${reason}`);
    setTimeout(async () => {
      this.reconnecting = false;
      try {
        await this.authenticate();
        await this.connect();
      } catch (e) {
        this.log.error('[Sensi] Reconnect failed', e);
        this.scheduleReconnect('retry');
      }
    }, 10000);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopKeepAlive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  shutdown(): void {
    this.closed = true;
    this.stopKeepAlive();
    this.teardownSocket();
  }

  onDeviceUpdate(listener: DeviceUpdateListener): void {
    this.listeners.add(listener);
  }

  private sendSet(json: any): boolean {
    const frame = '421' + JSON.stringify(json);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
      return true;
    }
    this.log.warn('[Sensi] WS not open. Dropping command:', json[0]);
    return false;
  }

  setTemperature(icdId: string, temp: number, mode: string, scale: string): boolean {
    return this.sendSet(['set_temperature', { icd_id: icdId, target_temp: temp, mode, scale }]);
  }

  setMode(icdId: string, value: string): boolean {
    return this.sendSet(['set_operating_mode', { icd_id: icdId, value }]);
  }

  /** value is 'on' (continuous) or 'auto' */
  setFanMode(icdId: string, value: string): boolean {
    return this.sendSet(['set_fan_mode', { icd_id: icdId, value }]);
  }

  setCirculatingFan(icdId: string, enabled: boolean, dutyCycle: number): boolean {
    return this.sendSet([
      'set_circulating_fan',
      { icd_id: icdId, value: { enabled: enabled ? 'on' : 'off', duty_cycle: dutyCycle } },
    ]);
  }
}
