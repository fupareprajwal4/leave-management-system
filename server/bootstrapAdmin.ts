import mongoose from 'mongoose';
import { env } from './config/env.js';
import { User } from './models/index.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();

if (!email || !name) {
  throw new Error(
    'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_NAME in the server environment for this one-time command.',
  );
}

await mongoose.connect(env.MONGODB_URI);

try {
  const activeAdmin = await User.findOne({
    role: 'admin',
    active: true,
    provisioned: true,
  }).select('_id email');

  if (activeAdmin) {
    console.log(
      `An active administrator already exists (${activeAdmin.email}); no account was changed.`,
    );
  } else {
    const existing = await User.findOne({ email });

    if (existing && existing.role !== 'admin') {
      throw new Error(
        `The email ${email} already belongs to a non-admin account. Refusing to elevate it automatically. Review the account in MongoDB and choose a dedicated bootstrap administrator email.`,
      );
    }

    if (existing) {
      existing.name = name;
      existing.emailVerified = true;
      existing.active = true;
      existing.provisioned = true;
      existing.departmentId = null;
      await existing.save();
      console.log(
        `Existing administrator account re-enabled for Google sign-in: ${existing.email}.`,
      );
    } else {
      const user = await User.create({
        name,
        email,
        emailVerified: true,
        role: 'admin',
        active: true,
        provisioned: true,
        departmentId: null,
      });
      console.log(
        `Bootstrap administrator provisioned: ${user.email}. Sign in using the matching verified Google account.`,
      );
    }
  }
} finally {
  await mongoose.disconnect();
}
