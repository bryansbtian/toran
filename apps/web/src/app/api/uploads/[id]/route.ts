import { ToranError, uuidSchema } from '@toran/shared';
import { MANAGE_GRANT_HEADER, verifyGrant } from '@toran/security';
import { findUploadSession } from '@toran/database';
import { assertSameOrigin, handler, json } from '@/server/http';
import { cancelUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/uploads/{id} - cancel an in-flight upload.
 *
 * Requires the manage grant issued when the upload was created, so a third
 * party who guesses an upload id cannot cancel someone else's transfer.
 */
export const DELETE = handler<{ id: string }>(
  'DELETE /api/uploads/[id]',
  async (request, context, params) => {
    assertSameOrigin(request, context);

    const uploadId = uuidSchema.safeParse(params.id);
    if (!uploadId.success) {
      throw new ToranError('NOT_FOUND');
    }

    const session = await findUploadSession(context.db, uploadId.data);
    if (!session) {
      throw new ToranError('NOT_FOUND');
    }

    const grant = verifyGrant(request.headers.get(MANAGE_GRANT_HEADER), {
      purpose: 'manage',
      subject: session.file.id,
      secret: context.config.app.secretKey,
      now: context.clock.now(),
    });
    if (!grant.valid) {
      // Same response as a missing upload: possession of a valid id must not
      // be confirmed to someone who cannot prove they created it.
      throw new ToranError('NOT_FOUND', { internal: `manage grant rejected: ${grant.reason}` });
    }

    await cancelUpload(context, uploadId.data);
    return json({ cancelled: true }, context);
  },
);
