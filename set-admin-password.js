/* set-admin-password.js — make your own admin password without ever typing it
   into a file, a URL, or a shared document. Nothing is sent anywhere: it only
   prints an SQL line for you to paste into phpMyAdmin.

   Usage (in the project folder, on your own PC):
       node set-admin-password.js                      prompts twice, hidden input
       node set-admin-password.js --email you@site.in   change which address
   If you would rather not run SQL: log in and use Settings -> Change password.
*/
const bcrypt = require('bcryptjs');
const readline = require('readline');

const emailArg = (() => {
  const i = process.argv.indexOf('--email');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'admin@softmarc.com';
})();

function hidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {                       // piped input (echoes anyway)
      const rl = readline.createInterface({ input: process.stdin });
      let out = '';
      rl.on('line', (l) => { out = l; rl.close(); });
      rl.on('close', () => resolve(out.trim()));
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let pw = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(pw);
      } else if (ch === '\u0003') { process.stdout.write('\ncancelled\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') { pw = pw.slice(0, -1); process.stdout.write('\b \b'); }
      else { pw += ch; process.stdout.write('*'); }
    };
    stdin.on('data', onData);
  });
}

const WEAK = ['admin123', 'password', 'password1', 'passw0rd', '12345678', '123456789', 'qwerty123', 'softmarc', 'welcome1'];

(async () => {
  let a = process.stdin.isTTY ? '' : '';
  if (!process.stdin.isTTY) a = await hidden('password: ');
  else {
    a = await hidden('new admin password (8+ chars, not a common word): ');
    const b = await hidden('repeat it: ');
    if (a !== b) { console.error('they did not match — nothing printed'); process.exit(1); }
  }
  const problem = a.length < 8 ? 'too short (needs 8 or more)'
    : WEAK.includes(a.toLowerCase()) ? 'far too common'
    : /^(.)\1+$/.test(a) ? 'one repeated character'
    : '';
  if (problem) { console.error('rejected: ' + problem + ' — nothing printed'); process.exit(1); }

  const hash = bcrypt.hashSync(a, 10);
  console.log('\nPaste this ONE block into phpMyAdmin (select softmarc_db -> SQL tab -> Go), then delete it from your clipboard:\n');
  console.log(`UPDATE users SET password_hash = '${hash}' WHERE email = '${emailArg}';`);
  console.log(`\n-- if that address does not exist yet, create it instead:`);
  console.log(`INSERT INTO users (full_name, email, password_hash, role) VALUES ('Admin', '${emailArg}', '${hash}', 'admin');`);
  console.log('\nSign in with the password you just typed. Nobody else — including whoever wrote this script — has seen it.');
})();
