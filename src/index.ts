import { API } from 'homebridge';
import { SensiPlatform, PLUGIN_NAME, PLATFORM_NAME } from './platform';

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SensiPlatform);
};
