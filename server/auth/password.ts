import bcrypt from 'bcryptjs';

const COST = 12;

// Hash compared against when the user doesn't exist, so login timing does not
// reveal whether an email is registered. Generated once, lazily.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('timing-equalizer', COST));

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password, await getDummyHash());
    return false;
  }
  return bcrypt.compare(password, hash);
}
