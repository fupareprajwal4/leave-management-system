import nodemailer from 'nodemailer';
import { EmailOutbox } from '../models/index.js';
import { env } from '../config/env.js';

export async function processEmailOutbox(batchSize = 20) {
  if (
    env.EMAIL_PROVIDER !== 'smtp' ||
    !env.SMTP_HOST ||
    !env.SMTP_USER ||
    !env.SMTP_PASSWORD
  ) {
    throw Object.assign(
      new Error('SMTP email is not configured.'),
      {
        status: 503,
        code: 'EMAIL_NOT_CONFIGURED',
      },
    );
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
  });

  const jobs = await EmailOutbox.find({
    $or: [
      {
        status: { $in: ['pending', 'failed'] },
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: { $lte: new Date() } },
        ],
      },
      {
        status: 'sending',
        updatedAt: {
          $lte: new Date(Date.now() - 10 * 60 * 1000),
        },
      },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(batchSize);

  let accepted = 0;
  let failed = 0;

  for (const job of jobs) {
    const claimed = await EmailOutbox.findOneAndUpdate(
      {
        _id: job._id,
        status: job.status,
      },
      {
        $set: {
          status: 'sending',
        },
        $inc: {
          attempts: 1,
        },
      },
      {
        new: true,
      },
    );

    if (!claimed) {
      continue;
    }

    try {
      const payload = claimed.payload || {};

      const attachments = Array.isArray(payload.attachments)
        ? payload.attachments.map((attachment: any) => ({
            filename: String(
              attachment.filename || 'attachment.bin',
            ),
            content: Buffer.from(
              String(attachment.contentBase64 || ''),
              'base64',
            ),
            contentType: String(
              attachment.contentType ||
                'application/octet-stream',
            ),
          }))
        : [];

      const info = await transporter.sendMail({
        from: env.EMAIL_FROM,
        to: claimed.recipient,
        subject:
          payload.subject ||
          `SGGS Leave Portal: ${claimed.eventType}`,
        text:
          payload.text ||
          `There is an update for leave application ${
            claimed.applicationId || ''
          }. Please sign in to the SGGSIE&T Leave Portal to review it.`,
        ...(payload.html ? { html: payload.html } : {}),
        ...(attachments.length ? { attachments } : {}),
      });

      claimed.status = 'accepted';
      claimed.providerReference = info.messageId;
      claimed.lastError = undefined;
      claimed.nextAttemptAt = undefined;

      await claimed.save();
      accepted++;
    } catch (error: any) {
      claimed.status = 'failed';
      claimed.lastError = String(
        error?.message || 'Email provider error',
      ).slice(0, 500);

      claimed.nextAttemptAt = new Date(
        Date.now() +
          Math.min(
            24 * 60 * 60 * 1000,
            60_000 *
              Math.pow(2, Math.min(claimed.attempts, 10)),
          ),
      );

      await claimed.save();
      failed++;
    }
  }

  return {
    scanned: jobs.length,
    accepted,
    failed,
  };
}