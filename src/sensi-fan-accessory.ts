import { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { SensiAPI, DeviceStatePacket } from './sensi-api';

/**
 * Exposes the thermostat's fan mode as a plain HomeKit switch:
 *   ON  -> fan_mode 'on'   (blower runs continuously)
 *   OFF -> fan_mode 'auto' (blower runs only when heating/cooling calls for it)
 *
 * A Switch is used rather than Fanv2 because the Home app does not surface
 * Fanv2's TargetFanState (manual/auto), which is the characteristic that
 * actually matches Sensi's semantics.
 */
export class SensiFanAccessory {
  private readonly service: Service;
  private continuous = false;

  constructor(
    private readonly log: Logging,
    private readonly accessory: PlatformAccessory,
    private readonly api: SensiAPI,
    private readonly hap: API['hap'],
    displayName: string
  ) {
    this.service =
      this.accessory.getServiceById(this.hap.Service.Switch, 'fan-mode') ||
      this.accessory.addService(this.hap.Service.Switch, displayName, 'fan-mode');

    this.service.setCharacteristic(this.hap.Characteristic.Name, displayName);
    if (this.hap.Characteristic.ConfiguredName) {
      this.service.setCharacteristic(this.hap.Characteristic.ConfiguredName, displayName);
    }

    this.service
      .getCharacteristic(this.hap.Characteristic.On)
      .onGet(() => this.continuous)
      .onSet(async (value: CharacteristicValue) => {
        const wanted = value === true;
        const mode = wanted ? 'on' : 'auto';
        const devId = this.accessory.context.deviceId;

        if (!this.api.setFanMode(devId, mode)) {
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // The thermostat echoes its new state over the WebSocket, but not
        // instantly; hold the requested value so the tile does not snap back.
        this.continuous = wanted;
        this.log.info(`[Sensi] Fan mode -> ${mode}`);
      });

    this.api.onDeviceUpdate((dev: DeviceStatePacket) => {
      if (dev.icd_id.toLowerCase() === this.accessory.context.deviceId) {
        this.updateFromState(dev);
      }
    });
  }

  private updateFromState(dev: DeviceStatePacket): void {
    const fanMode = dev.state?.fan_mode;
    if (typeof fanMode !== 'string') {
      return;
    }

    const continuous = fanMode === 'on';
    if (continuous !== this.continuous) {
      this.continuous = continuous;
      this.service.updateCharacteristic(this.hap.Characteristic.On, continuous);
      this.log.debug(`[Sensi] Fan mode reported as '${fanMode}'`);
    }
  }
}
