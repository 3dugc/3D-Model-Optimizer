import { Router, Request, Response, NextFunction } from 'express';
import type { CosObjectRef } from '../cloud/types';
import { createObjectStorageProvider } from '../cloud/object-storage';
import { cloudJobService } from '../jobs/job-service';
import type { CreateCloudJobInput } from '../jobs/types';
import { config } from '../config';
import { requireScope } from '../middleware';
import {
  assertTaskTypeAccess,
  assertTenantAccess,
  assertTenantObjectPrefix,
  isManifestObjectKey,
  parseCosJobManifest,
  requireTenantId,
} from '../jobs/cos-manifest';
import { HttpError } from '../utils/http-error';

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
  const scopedTenantId =
    req.apiPrincipal?.tenantIds?.length === 1 && !bodyTenantId && !headerTenantId ? req.apiPrincipal.tenantIds[0] : undefined;
  const tenantId = requireTenantId(bodyTenantId || headerTenantId || scopedTenantId);
  assertTenantAccess(req.apiPrincipal, tenantId);
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

/**
 * @openapi
 * /api/v1/jobs:
 *   post:
 *     tags: [Async Jobs]
 *     summary: Create an async heavy-backend job and return a COS upload grant when upload is pending.
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-tenant-id
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tenantId: { type: string }
 *               taskType: { type: string, example: model.optimize }
 *               filename: { type: string, example: source.glb }
 *               input:
 *                 $ref: '#/components/schemas/CosObjectRef'
 *               callbackUrl: { type: string, format: uri }
 *               idempotencyKey: { type: string }
 *     responses:
 *       202:
 *         description: Job accepted.
 */
router.post('/jobs', requireScope('jobs:create'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateJobBody;
    const tenantId = getTenantId(req, body.tenantId);
    const taskType = body.task?.type || body.taskType || config.cloud.defaultTaskType;
    assertTaskTypeAccess(req.apiPrincipal, taskType);
    if (body.input) assertTenantObjectPrefix(tenantId, body.input);
    const job = await cloudJobService.createJob({
      ...body,
      tenantId,
    });
    const uploadGrant =
      job.status === 'waiting_upload'
        ? await objectStorage.createUploadGrant({
            bucket: job.inputBucket,
            region: job.inputRegion,
            key: job.inputKey,
          })
        : undefined;

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
              grant: uploadGrant,
            }
          : undefined,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId', requireScope('jobs:read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    assertTenantAccess(req.apiPrincipal, job.tenantId);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/upload-grant:
 *   post:
 *     tags: [Async Jobs]
 *     summary: Refresh a short-lived COS upload grant for a waiting job.
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Upload grant.
 */
router.post('/jobs/:jobId/upload-grant', requireScope('upload:grant'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    assertTenantAccess(req.apiPrincipal, job.tenantId);
    if (job.status !== 'waiting_upload') {
      throw new HttpError(409, 'UPLOAD_NOT_PENDING', 'Job is not waiting for upload.');
    }
    const object = { bucket: job.inputBucket, region: job.inputRegion, key: job.inputKey };
    res.json({ jobId: job.id, upload: { object, uri: objectStorage.toUri(object), grant: await objectStorage.createUploadGrant(object) } });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/complete-upload:
 *   post:
 *     tags: [Async Jobs]
 *     summary: Mark an uploaded object complete and enqueue the job.
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated job.
 */
router.post('/jobs/:jobId/complete-upload', requireScope('jobs:complete'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await cloudJobService.getJob(req.params.jobId);
    if (!existing) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    assertTenantAccess(req.apiPrincipal, existing.tenantId);
    const input = req.body?.input as CosObjectRef | undefined;
    if (input) assertTenantObjectPrefix(existing.tenantId, input);
    const job = await cloudJobService.completeUpload(req.params.jobId, input);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/result-url:
 *   get:
 *     tags: [Async Jobs]
 *     summary: Return a short-lived download URL for a completed result.
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Download URL.
 */
router.get('/jobs/:jobId/result-url', requireScope('jobs:result'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await cloudJobService.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    assertTenantAccess(req.apiPrincipal, job.tenantId);
    if (job.status !== 'succeeded' || !job.outputBucket || !job.outputRegion || !job.outputKey) {
      res.status(409).json({ success: false, error: { code: 'RESULT_NOT_READY', message: 'Result is not ready' } });
      return;
    }
    const object = { bucket: job.outputBucket, region: job.outputRegion, key: job.outputKey };
    const download = await objectStorage.createDownloadUrl(object);
    res.json({ jobId: job.id, object, uri: objectStorage.toUri(object), download });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/cancel', requireScope('jobs:cancel'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await cloudJobService.getJob(req.params.jobId);
    if (!existing) {
      res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });
      return;
    }
    assertTenantAccess(req.apiPrincipal, existing.tenantId);
    const job = await cloudJobService.cancelJob(req.params.jobId);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/cos/events:
 *   post:
 *     tags: [Async Jobs]
 *     summary: Receive a COS event or COS-only manifest event and enqueue a job idempotently.
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       202:
 *         description: Event accepted.
 */
router.post('/cos/events', requireScope('cos:events'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CosEventBody;
    const input = normalizeCosEvent(body);
    if (isManifestObjectKey(input.key)) {
      const manifest = parseCosJobManifest(await objectStorage.readObjectText(input), input, req.apiPrincipal);
      const job = await cloudJobService.createJob(manifest);
      res.status(202).json({ job, source: 'manifest' });
      return;
    }

    const tenantId = getTenantId(req, body.tenantId);
    assertTenantObjectPrefix(tenantId, input);
    const filename = input.key.split('/').pop() || 'input.glb';
    const taskType = config.cloud.defaultTaskType;
    assertTaskTypeAccess(req.apiPrincipal, taskType);
    const job = await cloudJobService.createJob({
      tenantId,
      filename,
      input,
      taskType,
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
