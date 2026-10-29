/** usage: JWT_SECRET=... npm run token -- <user> <tenant> [room1,room2|*] */
import { signToken } from '../src/auth.js';
const [user, tenant, rooms] = process.argv.slice(2);
if (!user || !tenant) {
  console.error('usage: npm run token -- <user> <tenant> [rooms,comma,separated]');
  process.exit(1);
}
console.log(signToken(process.env.JWT_SECRET || 'dev-secret-change-me', { user, tenant, rooms: rooms ? rooms.split(',') : undefined }, 86400));
