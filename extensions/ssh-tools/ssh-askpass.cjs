#!/usr/bin/env node

const secret = process.env.PI_SSH_ASKPASS_SECRET;
if (typeof secret !== "string") process.exit(1);
process.stdout.write(`${secret}\n`);
