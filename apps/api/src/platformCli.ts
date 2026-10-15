/**
 * Platform console accounts from the server. Run inside the api container:
 *   docker compose exec api node dist/platformCli.js invite you@example.com ["Your Name"]   first admin, or a new setup link
 *   docker compose exec api node dist/platformCli.js list
 * "invite" prints a one-time link (72 hours) to choose a name and password. For someone who already has an account
 * it is a password reset link. The account is not tied to any company.
 */
import { closeAdminPool, adminPool } from './storage';
import { audit, issueSetup } from './platformAuth';

async function main() {
  const [cmd, email, ...name] = process.argv.slice(2);
  if (cmd === 'invite' && email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const { user, link } = await issueSetup(email, name.join(' '));
    await audit(null, 'admin.invite', null, { email: user.email, from: 'server' });
    console.log(`\n${user.has_password ? 'Password reset' : 'Setup'} link for ${user.email} (works once, for 72 hours):\n\n  ${link}\n`);
  } else if (cmd === 'list') {
    const rows = (await adminPool().query("SELECT email, name, active, password_hash IS NOT NULL AS ready, last_login_at FROM platform_users ORDER BY created_at")).rows;
    if (!rows.length) console.log('No platform admins yet. Create one with: invite you@example.com');
    for (const r of rows) console.log(`${r.email.padEnd(36)} ${(r.name || '-').padEnd(24)} ${!r.active ? 'removed' : r.ready ? `last sign-in ${r.last_login_at?.toISOString() ?? 'never'}` : 'invited, not set up yet'}`);
  } else {
    console.log('Usage: platformCli.js invite <email> [name] | list');
    process.exitCode = 1;
  }
}
main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => closeAdminPool());
