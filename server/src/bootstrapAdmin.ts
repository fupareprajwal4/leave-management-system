import mongoose from 'mongoose'; import { env } from './config/env.js'; import { User } from './models/index.js';
const email=process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase(); const name=process.env.BOOTSTRAP_ADMIN_NAME?.trim();
if(!email||!name) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_NAME for this one-time command.');
await mongoose.connect(env.MONGODB_URI);
try { const existing=await User.findOne({role:'admin',active:true,provisioned:true}); if(existing){console.log('An active provisioned administrator already exists; no account was changed.');process.exitCode=1;} else {const user=await User.create({name,email,emailVerified:true,role:'admin',active:true,provisioned:true,departmentId:null});console.log(`Bootstrap administrator provisioned: ${user.email}. Sign in using the matching verified Google account.`)} } finally { await mongoose.disconnect(); }
