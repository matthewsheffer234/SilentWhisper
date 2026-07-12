// PROJECT_PLAN.md Section 3, Authentication & Session Security: "Enforce a
// minimum password length and reject a small deny-list of common/breached
// passwords at signup, rather than relying on complexity rules alone."
export const MIN_PASSWORD_LENGTH = 10;

// A small, well-known deny-list (not a secret — the opposite of one) of the
// most common passwords found in public breach-analysis lists. This isn't a
// substitute for a full breached-password API, just a cheap floor that
// blocks the most obviously guessable values without punishing users with
// arbitrary complexity rules.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '123456789', '12345678',
  'qwerty', 'qwerty123', 'letmein', 'welcome', 'welcome1', 'admin', 'admin123',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'trustno1', 'abc123', 'abcd1234', '1q2w3e4r', 'passw0rd',
  'superman', 'starwars', 'whatever', 'freedom', 'letmein123',
]);

export function assertValidPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common. Please choose a different one.';
  }
  return null;
}
