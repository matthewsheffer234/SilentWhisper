import request from 'supertest';

export async function signup(app, username) {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ username, email: `${username}@example.com`, password: 'correct-horse-battery' });
  if (res.status !== 201) {
    throw new Error(`signup failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { userId: res.body.user.id, accessToken: res.body.accessToken };
}

export function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}
