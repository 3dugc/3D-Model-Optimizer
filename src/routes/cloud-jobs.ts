import { Router, Request, Response, NextFunction } from 'express';
import type { CosObjectRef } from '../cloud/types';
import { createObjectStorageProvider } from '../cloud/object-storage';
import { cloudJobService } from '../jobs/job-service';
import type { CreateCloudJobInput } from '../jobs/types';
import { config } from '../config';

const router = Router();
const objectStorage = createObjectStorageProvider();

interface CreateJobBody extends Omit<CreateCloudJobInput, 'tenantId'> {
  tenantId?: string;
}

interface CosEventBody {
  tenantId?: string;
  bucket?: string;
  region?: string;
  key?: string;
  etag?: string;
  size?: number;
  Records?: Array<{
    cos?: {
      cosBucket?: { name?: string; region?: string };
      cosObject?: { key?: string; eTag?: string; size?: number };
    };
  }>;
  callbackUrl?: string;
  callbackSigningSecret?: string;
  preset?: string;
  options?: CreateCloudJobInput['options'];
}

function getTenantId(req: Request, bodyTenantId?: string): string {
  const headerTenantId = req.header('x-tenant-id');
  const tenantId = bodyTenantId || headerTenantId;
  if (!tenantId) {
    throw new Error('tenantId is required in body or x-tenant-id header');
  }
  return tenantId;
}

function normalizeCosEvent(body: CosEventBody): CosObjectRef {
  if (body.bucket && body.key) {
    return {
      bucket: body.bucket,
      region: body.region || config.cloud.region,
      key: body.key,
      etag: body.etag,
      size: body.size,
    };
  }

  const record = body.Records?.[0];
  const bucket = record?.cos?.cosBucket?.name;
  const key = record?.cos?.cosObject?.key;
  if (!bucket || !key) {
    throw new Error('COS event must include bucket and key');
  }
  return {
    bucket,
    region: record?.cos?.cosBucket?.region || config.cloud.region,
    key: decodeURIComponent(key.replace(/\+/g, ' ')),
    etag: record?.cos?.cosObject?.eTag,
    size: record?.cos?.cosObject?.size,
  };
}

router.post('/jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateJobBody;
    const tenantId = getTenantId(req, body.tenantId);
    const job = await cloudJobService.createJob({
      ...body,
      tenantId,
    });

    res.status(202).json({
      job,
      upload:
        job.status === 'waiting_upload'
          ? {
              provider: objectStorage.providerName,
              object: {
                bucket: job.inputBucket,
                region: job.inputRegion,
                key: job.inputKey,
              },
              uri: objectStorage.toUri({
                bucket: job.inputBucket,
                region: job.inputRegion,
                key: job.inputKey,
              }),
            }
          : undefined,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/complete-upload', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.completeUpload(req.params.jobId, req.body?.input as CosObjectRef | undefined);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId/result-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    if (job.status !== 'succeeded' || !job.outputBucket || !job.outputRegion || !job.outputKey) {
      res.status(409).json({ success: false, error: { code: 'RESULT_NOT_READY', message: 'Result is not ready' } });
      return;
    }
    const object = { bucket: job.outputBucket, region: job.outputRegion, key: job.outputKey };
    res.json({ jobId: job.id, object, uri: objectStorage.toUri(object) });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.cancelJob(req.params.jobId);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

router.post('/cos/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CosEventBody;
    const input = normalizeCosEvent(body);
    const tenantId = getTenantId(req, body.tenantId);
    const filename = input.key.split('/').pop() || 'input.glb';
    const job = await cloudJobService.createJob({
      tenantId,
      filename,
      input,
      preset: body.preset as CreateCloudJobInput['preset'],
      options: body.options,
      callbackUrl: body.callbackUrl,
      callbackSigningSecret: body.callbackSigningSecret,
      idempotencyKey: `${input.bucket}:${input.region}:${input.key}:${input.etag || ''}`,
    });
    res.status(202).json({ job });
  } catch (error) {
    next(error);
  }
});

export default router;
