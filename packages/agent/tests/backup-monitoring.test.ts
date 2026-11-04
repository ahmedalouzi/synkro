import { scrubString } from '../src/utils/sentry-scrubber';

export async function runTests() {
  console.log('  Running Sentry Scrubber & Health Monitoring tests...');

  // 1. Bearer and session tokens
  const rawTokens = 'Request failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and session_token=abc123xyz_456';
  const scrubbedTokens = scrubString(rawTokens);
  if (scrubbedTokens.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9') || scrubbedTokens.includes('abc123xyz_456')) {
    throw new Error('Failed to scrub tokens');
  }
  if (!scrubbedTokens.includes('Bearer [REDACTED]') || !scrubbedTokens.includes('session_token=[REDACTED]')) {
    throw new Error('Expected redacted placeholder for tokens');
  }

  // 2. API Keys (Google standard 39-char key: 'AIza' + 35 alphanumeric chars)
  const rawGoogle = 'Gemini key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p67';
  const scrubbedGoogle = scrubString(rawGoogle);
  if (scrubbedGoogle.includes('AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p67') || !scrubbedGoogle.includes('[REDACTED_API_KEY]')) {
    throw new Error('Failed to scrub Google API key');
  }

  const rawOpenAI = 'My key is sk-abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';
  const scrubbedOpenAI = scrubString(rawOpenAI);
  if (scrubbedOpenAI.includes('sk-abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234') || !scrubbedOpenAI.includes('[REDACTED_API_KEY]')) {
    throw new Error('Failed to scrub OpenAI API key');
  }

  // 3. File paths
  const posixPath = '/home/synkro/secrets/keys/keystore.jks failed to load';
  const scrubbedPosix = scrubString(posixPath);
  if (scrubbedPosix.includes('/home/synkro/secrets/keys') || !scrubbedPosix.includes('[REDACTED]/keystore.jks')) {
    throw new Error('Failed to scrub posix path');
  }

  const winPath = 'Error at C:\\Users\\Administrator\\Desktop\\peep\\apps\\server\\src\\index.ts line 42';
  const scrubbedWin = scrubString(winPath);
  if (scrubbedWin.includes('Administrator') || !scrubbedWin.includes('[REDACTED]/index.ts')) {
    throw new Error('Failed to scrub Windows path');
  }

  console.log('  🟢 Sentry Scrubber & Health Monitoring tests passed.');
}

export default runTests;
