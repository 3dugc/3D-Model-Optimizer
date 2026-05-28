import { config } from '../config';
import { TencentCloudApiClient } from '../cloud/tencent-cloud-api';

export interface CustomAlarmNotifier {
  send(title: string, description: string): Promise<void>;
}

export class LogOnlyAlarmNotifier implements CustomAlarmNotifier {
  async send(): Promise<void> {
    return undefined;
  }
}

export class TencentCustomAlarmNotifier implements CustomAlarmNotifier {
  private readonly client = new TencentCloudApiClient({
    host: 'monitor.tencentcloudapi.com',
    service: 'monitor',
    version: '2018-07-24',
    region: config.cloud.region,
  });

  async send(title: string, description: string): Promise<void> {
    await this.client.request('SendCustomAlarmMsg', {
      Text: title,
      Desp: description,
    });
  }
}

export function createCustomAlarmNotifier(): CustomAlarmNotifier {
  return config.cloud.monitorTencentCustomAlarmEnabled
    ? new TencentCustomAlarmNotifier()
    : new LogOnlyAlarmNotifier();
}
