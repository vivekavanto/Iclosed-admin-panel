import test from 'node:test';
import assert from 'node:assert/strict';
import { staffGoogleAuthorizationUrl } from '../src/lib/staffGoogleSignIn.ts';

type Auth = Parameters<typeof staffGoogleAuthorizationUrl>[0];
const project = 'https://staff-test.supabase.co';
const origin = 'https://staff.example.test';
const fake = (url: string | null, error: unknown = null) => ({
  signInWithOAuth: async () => ({ data: { provider: 'google', url }, error }),
}) as Auth;

test('server Google start requests identity only and binds the return to the Admin callback', async () => {
  let observed: unknown;
  const auth = { signInWithOAuth: async (credentials: unknown) => {
    observed = credentials;
    return { data: { provider: 'google', url: project + '/auth/v1/authorize?provider=google' }, error: null };
  } } as Auth;
  const result = await staffGoogleAuthorizationUrl(auth, origin, project);
  assert.equal(result, project + '/auth/v1/authorize?provider=google');
  assert.deepEqual(observed, {
    provider: 'google', options: {
      redirectTo: origin + '/admin/auth/confirm', scopes: 'openid email profile',
      queryParams: { prompt: 'select_account' }, skipBrowserRedirect: true,
    },
  });
});

test('provider errors and missing authorization URLs fail closed', async () => {
  assert.equal(await staffGoogleAuthorizationUrl(fake(null), origin, project), null);
  assert.equal(await staffGoogleAuthorizationUrl(fake(project + '/auth/v1/authorize', { message: 'unavailable' }), origin, project), null);
});

test('provider start cannot become an open redirect to another origin or path', async () => {
  for (const url of [
    'https://staff-test.supabase.co.attacker.test/auth/v1/authorize',
    'https://staff-test.supabase.co@attacker.test/auth/v1/authorize',
    'http://staff-test.supabase.co/auth/v1/authorize',
    project + '/other-path', 'javascript:alert(1)',
  ]) assert.equal(await staffGoogleAuthorizationUrl(fake(url), origin, project), null, url);
});
