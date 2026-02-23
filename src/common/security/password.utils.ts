const MIN_PASSWORD_LENGTH = 12;

/**
 * Regex requiring at least one lowercase, uppercase, digit and symbol.
 */
const PASSWORD_COMPLEXITY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;

/**
 * Human readable description of the password policy.
 */
export const PASSWORD_POLICY_DESCRIPTION =
  "Password must be at least 12 characters long and include uppercase, lowercase, number, and special character.";

/**
 * Validate if the provided password meets the complexity requirements.
 */
export function isPasswordStrong(password: string): boolean {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return false;
  }
  return PASSWORD_COMPLEXITY_REGEX.test(password);
}
