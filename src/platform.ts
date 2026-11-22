import fs from 'fs';
import path from 'path';
import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { SensiAPI, DeviceStatePacket } from './sensi-api';
import { SensiThermostatAccessory } from './sensi-thermostat-accessory';
import { SensiSensorAccessory } from './sensi-sensor-accessory';
import { SensiFanAccessory } from './sensi-fan-accessory';

export const PLUGIN_NAME = 'homebridge-sensi-fan';
export const PLATFORM_NAME = 'SensiFanPlatform';

interface TokenStore {
  seedToken: string;
  currentToken: string;
}

export class SensiPlatform implements DynamicPlatformPlugin {
  private readonly cached: Map<string, PlatformAccessory> = new Map();
  private readonly configured: Set<string> = new Set();
  private readonly tokenPath: string;
  private sensiApi?: SensiAPI;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API
  ) {
    this.tokenPath = path.join(this.api.user.storagePath(), 'sensi-fan-token.json');

    this.api.on('didFinishLaunching', () => {
      this.initialize().catch((e) => this.log.error('[Sensi] Init error:', e));
    });
    this.api.on('shutdown', () => this.sensiApi?.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`[Sensi] Restoring cached accessory: ${accessory.displayName}`);
    this.cached.set(accessory.UUID, accessory);
  }

  /**
   * Sensi rotates the refresh token on each exchange, so the token in config.json
   * is only a seed. Once used, the rotated token is kept on disk. If the seed in
   * config.json changes the user has pasted a fresh token, so that wins.
   */
  private loadToken(seed: string): string {
    try {
      const stored = JSON.parse(fs.readFileSync(this.tokenPath, 'utf-8')) as TokenStore;
      if (stored.seedToken === seed && stored.currentToken) {
        this.log.info('[Sensi] Using stored (rotated) refresh token.');
        return stored.currentToken;
      }
      this.log.info('[Sensi] Refresh token in config.json changed; using it and discarding stored token.');
    } catch {
      /* no stored token yet */
    }
    return seed;
  }

  private saveToken(seed: string, current: string): void {
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify({ seedToken: seed, currentToken: current }), {
        mode: 0o600,
      });
    } catch (e) {
      this.log.warn('[Sensi] Could not persist rotated refresh token:', e);
    }
  }

  async initialize(): Promise<void> {
    const seed = (this.config.refreshToken as string | undefined)?.trim();
    if (!seed) {
      this.log.error('[Sensi] No refresh token configured - cannot connect. See the plugin settings.');
      return;
    }

    const sensiApi = new SensiAPI(
      this.loadToken(seed),
      this.log,
      this.config.clientId as string | undefined,
      this.config.clientSecret as string | undefined
    );
    this.sensiApi = sensiApi;
    sensiApi.onTokenRefreshed((token) => this.saveToken(seed, token));

    try {
      await sensiApi.authenticate();
    } catch (e) {
      this.log.error(
        '[Sensi] Authentication failed. The refresh token is probably expired - capture a new one and update the plugin settings.',
        e
      );
      return;
    }

    sensiApi.onDeviceUpdate((dev) => this.handleDevice(sensiApi, dev));
    await sensiApi.connect();
  }

  private handleDevice(sensiApi: SensiAPI, dev: DeviceStatePacket): void {
    const id = dev.icd_id.toLowerCase();
    if (this.configured.has(id)) {
      return;
    }
    this.configured.add(id);

    const name = dev.registration?.name ?? 'Sensi Thermostat';
    const uuid = this.api.hap.uuid.generate(id);

    // Reuse the cached accessory across restarts; registering a second accessory
    // with the same UUID makes Homebridge throw.
    const existing = this.cached.get(uuid);
    const accessory = existing ?? new this.api.platformAccessory(name, uuid);
    accessory.context.deviceId = id;

    const suffix = (this.config.fanSwitchSuffix as string | undefined)?.trim() || 'Fan';
    new SensiFanAccessory(this.log, accessory, sensiApi, this.api.hap, `${name} ${suffix}`);

    if (this.config.exposeThermostat !== false) {
      new SensiThermostatAccessory(this.log, accessory, sensiApi, this.api.hap);
    }
    if (this.config.exposeSensors !== false) {
      new SensiSensorAccessory(this.log, accessory, sensiApi, this.api.hap);
    }

    if (existing) {
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(`[Sensi] Updated accessory: ${name}`);
    } else {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`[Sensi] Registered accessory: ${name}`);
    }
  }
}
